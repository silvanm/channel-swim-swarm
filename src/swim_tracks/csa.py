"""Scraper for channelswimmingassociation.com: the yearly swim list, each swim's
detail page, and the pilot-boat track behind it.

Unlike CS&PF, every CSA swim page asks its track feed for exactly the swim:
`/feeds/tracks-xml.php?mmsi=<boat>&from_date=<start>&to_date=<finish>`, with
timezone offsets. So start and finish come straight from the feed URL and no
trimming is needed. Fixes arrive every ~10 minutes.
"""

import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

BASE = "https://www.channelswimmingassociation.com"
LIST_URL = f"{BASE}/swims"
FEED = re.compile(r"/feeds/tracks-xml\.php\?mmsi=(\d+)&from_date=([^&\"]+)&to_date=([^&\"]+)")


def client() -> httpx.Client:
    return httpx.Client(
        base_url=BASE,
        headers={"User-Agent": "Mozilla/5.0 (channel-crossing swim_tracks)"},
        follow_redirects=True,
        timeout=30,
    )


def list_swim_paths(c: httpx.Client, year: int) -> list[str]:
    """All /swim/<id>/<slug> links for a season, across the paginated list."""
    paths: list[str] = []
    page = 1
    while True:
        soup = BeautifulSoup(c.get("/swims", params={"year": year, "page": page}).text, "html.parser")
        found = [a["href"] for a in soup.select('a[href^="/swim/"]') if re.match(r"/swim/\d+/", a["href"])]
        new = [p for p in dict.fromkeys(found) if p not in paths]
        if not new:
            return paths
        paths += new
        page += 1
        time.sleep(0.3)


def fetch_swim(c: httpx.Client, path: str) -> dict:
    """Detail page -> {field: value} plus id, path and the feed parameters."""
    html = c.get(path).text
    soup = BeautifulSoup(html, "html.parser")
    fields = {}
    for tr in soup.select("table#dt_basic tr"):
        tds = tr.find_all("td")
        if len(tds) == 2:
            key = tds[0].get_text(" ", strip=True)
            if key == "YMM" or key in fields:  # the "latest swims" sidebar uses the same table id
                break
            items = [li.get_text(" ", strip=True) for li in tds[1].find_all("li")]
            fields[key] = ", ".join(items) if items else tds[1].get_text(" ", strip=True)
    m = FEED.search(html)
    fields["id"] = "c" + path.split("/")[2]
    fields["path"] = path
    if m:
        fields["mmsi"], fields["from"], fields["to"] = m.group(1), m.group(2), m.group(3)
    return fields


def fetch_track_xml(c: httpx.Client, swim: dict) -> str:
    return c.get(
        "/feeds/tracks-xml.php",
        params={"mmsi": swim["mmsi"], "from_date": swim["from"], "to_date": swim["to"]},
    ).text


def parse_track_xml(text: str) -> list[dict]:
    """<marker latitude=… longitude=… speed=… timestamp="4th October 2026 4:06am"/>, UK local time."""
    pts = []
    for mk in ET.fromstring(text).iter("marker"):
        ts = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", mk.get("timestamp", ""))
        pts.append(
            {
                "t": datetime.strptime(ts, "%d %B %Y %I:%M%p"),
                "lat": float(mk.get("latitude")),
                "lng": float(mk.get("longitude")),
            }
        )
    pts.sort(key=lambda p: p["t"])
    return pts


def cache_dir(root: Path, year: int) -> Path:
    d = root / "data" / "raw" / str(year) / "csa"
    d.mkdir(parents=True, exist_ok=True)
    return d
