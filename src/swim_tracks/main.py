import json
import time
from enum import Enum
from pathlib import Path

import typer

from . import csa, cspf
from .build import build_year

ROOT = Path(__file__).resolve().parents[2]

app = typer.Typer(help="CS&PF- und CSA-Schwimm-Tracks laden und fuer die Karte aufbereiten.", no_args_is_help=True)


class Org(str, Enum):
    all = "all"
    cspf = "cspf"
    csa = "csa"


def fetch_cspf(year: int, refresh: bool) -> None:
    out = cspf.cache_dir(ROOT, year)
    with cspf.client() as c:
        swims = cspf.list_swims(c, year)
        typer.echo(f"CS&PF: {len(swims)} Swims {year} ({sum(s.kind == 'solo' for s in swims)} solo)")
        (out / "swims.json").write_text(json.dumps([s.to_dict() for s in swims], indent=1, ensure_ascii=False))
        for i, s in enumerate(swims, 1):
            f = out / f"{s.id}.csv"
            if f.exists() and not refresh:
                continue
            try:
                text, window = cspf.fetch_track_csv(c, s)
            except Exception as e:  # one broken route page must not stop the season
                typer.echo(f"  [{i}/{len(swims)}] {s.name}: FEHLER {e}", err=True)
                continue
            f.write_text(text)
            (out / f"{s.id}.window.json").write_text(json.dumps(window))
            typer.echo(f"  [{i}/{len(swims)}] {s.name}: {len(cspf.parse_track_csv(text))} Fixes")


def fetch_csa(year: int, refresh: bool) -> None:
    out = csa.cache_dir(ROOT, year)
    index = out / "swims.json"
    known = {s["path"]: s for s in json.loads(index.read_text())} if index.exists() and not refresh else {}
    with csa.client() as c:
        paths = csa.list_swim_paths(c, year)
        typer.echo(f"CSA: {len(paths)} Swims {year}")
        swims = []
        for i, p in enumerate(paths, 1):
            s = known.get(p)
            if s is None:
                s = csa.fetch_swim(c, p)
                time.sleep(0.3)
            swims.append(s)
            f = out / f"{s['id']}.xml"
            if "mmsi" not in s:
                typer.echo(f"  [{i}/{len(paths)}] {p}: kein Track-Feed", err=True)
                continue
            if f.exists() and not refresh:
                continue
            try:
                text = csa.fetch_track_xml(c, s)
                n = len(csa.parse_track_xml(text))
            except Exception as e:
                typer.echo(f"  [{i}/{len(paths)}] {p}: FEHLER {e}", err=True)
                continue
            f.write_text(text)
            typer.echo(f"  [{i}/{len(paths)}] {s.get('Name') or s.get('Team Name')}: {n} Fixes")
            time.sleep(0.3)
        index.write_text(json.dumps(swims, indent=1, ensure_ascii=False))


@app.command()
def fetch(
    year: int = typer.Option(2026, help="Saison"),
    org: Org = typer.Option(Org.all, help="Verband"),
    refresh: bool = typer.Option(False, help="Bereits geladene Daten erneut laden"),
):
    """Swim-Listen und Tracks von cspf.co.uk und channelswimmingassociation.com nach data/raw/<jahr>/ laden."""
    if org in (Org.all, Org.cspf):
        fetch_cspf(year, refresh)
    if org in (Org.all, Org.csa):
        fetch_csa(year, refresh)


@app.command()
def build(year: int = typer.Option(2026, help="Saison")):
    """Tracks aufbereiten und web/data/tracks_<jahr>.json schreiben."""
    path = build_year(ROOT, year)
    typer.echo(f"geschrieben: {path.relative_to(ROOT)}")


@app.command()
def og(out: Path = typer.Option(ROOT / "web" / "og.png", help="Zieldatei")):
    """Share-Bild fuer Facebook & Co.: die Seite mit ?og bei 1200x630, 2x gerendert."""
    import functools
    import threading
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    from playwright.sync_api import sync_playwright

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT / "web"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=2)
            page.goto(f"http://127.0.0.1:{server.server_port}/?og", wait_until="networkidle")
            page.wait_for_function("window.ogReady === true")
            page.wait_for_load_state("networkidle")  # tiles for the final view
            page.evaluate("document.fonts.ready")
            page.wait_for_timeout(500)
            page.screenshot(path=str(out))
            browser.close()
    finally:
        server.shutdown()
    typer.echo(f"geschrieben: {out.relative_to(ROOT)}")


if __name__ == "__main__":
    app()
