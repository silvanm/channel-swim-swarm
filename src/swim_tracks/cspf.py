"""Scraper for cspf.co.uk: the yearly swim list and the AIS track CSV behind each swim.

The site redirects in a loop unless the session cookie is kept, so everything
goes through one httpx.Client with a cookie jar.
"""

import csv
import hashlib
import io
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

BASE = "https://cspf.co.uk"
LIST_URL = f"{BASE}/cs-and-pf-swims"
CSV_LINK = re.compile(r"https://cspf\.co\.uk/kml/[^\"'/]+/3")
WINDOW = re.compile(r"<h3>(.+?) track from (\d\d:\d\d) on (.+?) to (\d\d:\d\d) on (.+?)</h3>")


@dataclass
class Swim:
    id: str
    kind: str  # "solo" | "relay"
    date: str  # as listed, e.g. "21st June"
    name: str  # swimmer, or relay team incl. "(n)"
    pilots: str  # "Eddie Spelling / Pegasus"
    boat: str
    time: str  # "10:03:00"
    route_url: str

    def to_dict(self) -> dict:
        return asdict(self)


def client() -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": "Mozilla/5.0 (channel-crossing swim_tracks)"},
        follow_redirects=True,
        timeout=30,
    )


def list_swims(c: httpx.Client, year: int) -> list[Swim]:
    c.get(LIST_URL)  # sets the session cookie
    html = c.post(LIST_URL, data={"year": str(year)}).text
    soup = BeautifulSoup(html, "html.parser")
    swims: list[Swim] = []
    for h3 in soup.find_all("h3"):
        title = h3.get_text()
        kind = "solo" if title.startswith("Solo") else "relay" if title.startswith("Relay") else None
        if kind is None:
            continue
        table = h3.find_next("table")
        for tr in table.select("tbody tr"):
            tds = tr.find_all("td")
            link = tr.select_one("a.popup")
            if len(tds) < 5 or link is None:
                continue
            pilots = tds[2].get_text(strip=True)
            date, name = tds[0].get_text(strip=True), tds[1].get_text(strip=True)
            # relay rows carry no id attribute; derive a stable one from the row itself
            sid = link.get("id") or "r" + hashlib.sha1(f"{year}|{date}|{name}".encode()).hexdigest()[:8]
            swims.append(
                Swim(
                    id=sid,
                    kind=kind,
                    date=date,
                    name=name,
                    pilots=pilots,
                    boat=pilots.split("/")[-1].strip(),
                    time=tds[3].get_text(strip=True),
                    route_url=link["href"],
                )
            )
    return swims


def fetch_track_csv(c: httpx.Client, swim: Swim) -> tuple[str, dict]:
    """Return the raw CSV and the tracking window shown on the route page."""
    page = c.get(swim.route_url).text
    m = CSV_LINK.search(page)
    if not m:
        raise ValueError(f"no CSV link on route page of swim {swim.id}")
    w = WINDOW.search(page)
    window = {}
    if w:
        window = {"boat": w.group(1), "from": f"{w.group(3)} {w.group(2)}", "to": f"{w.group(5)} {w.group(4)}"}
    time.sleep(0.3)
    return c.get(m.group(0)).text, window


def parse_track_csv(text: str) -> list[dict]:
    """CSV columns: n, Date/Time (dd/mm/yyyy HH:MM), Region, Latitude, Longitude, Speed, Direction.

    Speed is speed over ground in tenths of a knot.
    """
    pts = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7 or not row[0].strip().isdigit():
            continue
        pts.append(
            {
                "t": datetime.strptime(row[1].strip(), "%d/%m/%Y %H:%M"),
                "region": row[2].strip(),
                "lat": float(row[3]),
                "lng": float(row[4]),
                "sog": int(row[5]) / 10 if row[5].strip() else None,
            }
        )
    return pts


def cache_dir(root: Path, year: int) -> Path:
    d = root / "data" / "raw" / str(year)
    d.mkdir(parents=True, exist_ok=True)
    return d
