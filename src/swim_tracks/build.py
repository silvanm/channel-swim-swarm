"""Cut each pilot-boat track to the actual crossing and write one JSON for the map.

CSA tracks come pre-cut (see csa.py). CS&PF serves the AIS feed for a window rounded out to the half hour around the
swim (e.g. 04:00–14:30 for a 10:03 swim), so the start lies within the first
~30 minutes of the window. We slide a window of exactly the official swim time
across it and keep the placement whose end is closest to the French coast —
the boat stands off a few hundred metres while the swimmer clears the water.

Times in the CSV are taken as UK local time (BST in season).
"""

import json
import math
import re
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import csa, cspf, tides

UK = ZoneInfo("Europe/London")

# Simplified French coast, Boulogne -> Gris-Nez -> Calais (from the simulator's sim.js)
FRANCE = [
    (50.7270, 1.5735), (50.7405, 1.5960), (50.7690, 1.6060), (50.8035, 1.6005),
    (50.8230, 1.5905), (50.8520, 1.5820), (50.8685, 1.5810), (50.8890, 1.6510),
    (50.9060, 1.6720), (50.9280, 1.7100), (50.9470, 1.7520), (50.9690, 1.8510),
    (50.9830, 1.9650), (51.0000, 2.1000),
]
LANDMARKS = [
    ("Wimereux", 50.770, 1.605), ("Ambleteuse", 50.807, 1.600), ("Audresselles", 50.824, 1.591),
    ("Cap Gris-Nez", 50.8685, 1.581), ("Tardinghen", 50.880, 1.625), ("Wissant", 50.887, 1.664),
    ("Cap Blanc-Nez", 50.925, 1.705), ("Escalles", 50.917, 1.715), ("Sangatte", 50.945, 1.752),
    ("Calais", 50.966, 1.850),
]
KM_LAT = 111.2
KM_LNG = 111.2 * math.cos(math.radians(51))


def _xy(lat: float, lng: float) -> tuple[float, float]:
    return lng * KM_LNG, lat * KM_LAT


def dist_to_france(lat: float, lng: float) -> float:
    px, py = _xy(lat, lng)
    best = math.inf
    for (a, b), (c, d) in zip(FRANCE, FRANCE[1:]):
        ax, ay = _xy(a, b)
        bx, by = _xy(c, d)
        dx, dy = bx - ax, by - ay
        u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(px - ax - u * dx, py - ay - u * dy))
    return best


def nearest_landmark(lat: float, lng: float) -> str:
    px, py = _xy(lat, lng)
    return min(LANDMARKS, key=lambda m: math.hypot(px - _xy(m[1], m[2])[0], py - _xy(m[1], m[2])[1]))[0]


def interp(pts: list[dict], t: datetime) -> tuple[float, float]:
    if t <= pts[0]["t"]:
        return pts[0]["lat"], pts[0]["lng"]
    for a, b in zip(pts, pts[1:]):
        if a["t"] <= t <= b["t"]:
            span = (b["t"] - a["t"]).total_seconds() or 1
            u = (t - a["t"]).total_seconds() / span
            return a["lat"] + u * (b["lat"] - a["lat"]), a["lng"] + u * (b["lng"] - a["lng"])
    return pts[-1]["lat"], pts[-1]["lng"]


def parse_duration(s: str) -> timedelta:
    h, m, *sec = (int(x) for x in s.strip().split(":"))
    return timedelta(hours=h, minutes=m, seconds=sec[0] if sec else 0)


def parse_legs(s: str) -> list[timedelta]:
    """'10:03:00' -> one leg; doubles are listed as '12:05:47+ 13:16:41= 25:22:28'."""
    return [parse_duration(x) for x in s.split("=")[0].split("+")]


def parse_window_start(w: dict) -> datetime | None:
    if not w.get("from"):
        return None
    txt = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", w["from"])
    return datetime.strptime(txt, "%d %b %Y %H:%M")


def trim(
    pts: list[dict], duration: timedelta, window_start: datetime | None, to_france: timedelta
) -> tuple[datetime, float]:
    """Pick the swim start; returns (start, distance to France in km at start + to_france).

    `to_france` is the whole swim for a single and the first leg for a double.
    """
    lo = window_start or pts[0]["t"]
    hi = pts[-1]["t"] - duration
    if hi < lo:  # swim longer than the feed: anchor at the first fix
        return pts[0]["t"], dist_to_france(*interp(pts, pts[0]["t"] + to_france))
    best = (math.inf, lo)
    t = lo
    while t <= hi:
        d = dist_to_france(*interp(pts, t + to_france))
        best = min(best, (d, t))
        t += timedelta(minutes=1)
    return best[1], best[0]


def team_size(name: str) -> int | None:
    m = re.search(r"\((\d+)\)\s*$", name)
    return int(m.group(1)) if m else None


def clip(pts: list[dict], start: datetime, end: datetime) -> list[list[float]]:
    """Track as [minutes since start, lat, lng], with interpolated end points."""
    dur = (end - start).total_seconds() / 60
    track = [[0, *interp(pts, start)]]
    for p in pts:
        if start < p["t"] < end:
            track.append([round((p["t"] - start).total_seconds() / 60, 1), p["lat"], p["lng"]])
    track.append([round(dur, 1), *interp(pts, end)])
    return [[m, round(la, 5), round(ln, 5)] for m, la, ln in track]


def tide_fields(start: datetime) -> dict:
    start_utc = start.replace(tzinfo=UK)
    return {
        "start": start_utc.isoformat(),
        "hw": round(tides.hours_from_hw(start_utc), 2),
        "spring": round(tides.spring_factor(start_utc), 2),
    }


def build_cspf(root: Path, year: int) -> list[dict]:
    raw = cspf.cache_dir(root, year)
    out = []
    for s in json.loads((raw / "swims.json").read_text()):
        f = raw / f"{s['id']}.csv"
        if not f.exists():
            continue
        pts = cspf.parse_track_csv(f.read_text())
        if len(pts) < 3:
            continue
        window = json.loads((raw / f"{s['id']}.window.json").read_text() or "{}")
        legs = parse_legs(s["time"])
        dur = sum(legs, timedelta())
        start, end_km = trim(pts, dur, parse_window_start(window), legs[0])
        end = start + dur
        out.append(
            {
                "id": s["id"],
                "org": "cspf",
                "kind": s["kind"],
                "name": re.sub(r"\s*\(\d+\)\s*$", "", s["name"]).strip(),
                "team": team_size(s["name"]),
                "pilots": s["pilots"],
                "boat": s["boat"],
                **tide_fields(start),
                "minutes": round(dur.total_seconds() / 60, 2),
                "time": s["time"].split("=")[-1].strip(),
                "legs": len(legs),
                "landing": nearest_landmark(*interp(pts, start + legs[0])),
                "end_km": round(end_km, 2),
                # AIS feed ends well before the official finish, or never reaches France
                "partial": pts[-1]["t"] < end - timedelta(minutes=30) or end_km > 2,
                "track": clip(pts, start, end),
            }
        )
    return out


def build_csa(root: Path, year: int) -> list[dict]:
    """CSA feeds are already cut to the swim: start and finish come from the feed URL."""
    raw = csa.cache_dir(root, year)
    index = raw / "swims.json"
    if not index.exists():
        return []
    out = []
    for s in json.loads(index.read_text()):
        f = raw / f"{s['id']}.xml"
        if "mmsi" not in s or not f.exists():
            continue
        pts = csa.parse_track_xml(f.read_text())
        if len(pts) < 3:
            continue
        # feed parameters carry an offset, marker timestamps are UK local
        start = datetime.fromisoformat(s["from"]).astimezone(UK).replace(tzinfo=None)
        end = datetime.fromisoformat(s["to"]).astimezone(UK).replace(tzinfo=None)
        typ, _, route = s.get("Type / Route", "").partition(" / ")
        relay = re.match(r"Relay \((\d+)", typ)
        ways = re.search(r"(\d+) way", typ)
        pilots = s.get("Pilot / Vessel", "")
        end_lat, end_lng = interp(pts, end)
        end_km = dist_to_france(end_lat, end_lng)
        out.append(
            {
                "id": s["id"],
                "org": "csa",
                "kind": "relay" if relay else "solo",
                "name": s.get("Team Name") or s.get("Name", "?"),
                "team": int(relay.group(1)) if relay else None,
                "members": s.get("Swimmers"),
                "country": s.get("Country"),
                "route": route,
                "pilots": pilots,
                "boat": pilots.split("/")[-1].strip(),
                **tide_fields(start),
                "minutes": round((end - start).total_seconds() / 60, 2),
                "time": s.get("Time", "").split()[0],
                "legs": int(ways.group(1)) if ways else 1,
                "landing": nearest_landmark(end_lat, end_lng),
                "end_km": round(end_km, 2),
                "partial": pts[0]["t"] > start + timedelta(minutes=30)
                or pts[-1]["t"] < end - timedelta(minutes=30)
                or end_km > 2,
                "track": clip(pts, start, end),
            }
        )
    return out


def build_year(root: Path, year: int) -> Path:
    out = build_cspf(root, year) + build_csa(root, year)
    out.sort(key=lambda r: r["start"])
    dest = root / "web" / "data" / f"tracks_{year}.json"
    sources = {"cspf": cspf.LIST_URL, "csa": csa.LIST_URL}
    dest.write_text(json.dumps({"year": year, "sources": sources, "swims": out}, separators=(",", ":")))
    return dest
