# La Manche 2026 — Swarm

Alle CS&PF- und CSA-Querungen einer Saison als animierter Schwarm auf der Karte. Man kann
den ganzen Schwarm laufen lassen oder eine einzelne Querung herauspicken.

## Run

```fish
task setup     # .venv (uv) + Abhaengigkeiten
task fetch     # Listen + Tracks von CS&PF und CSA nach data/raw/2026/ (gecacht); -- --org csa fuer nur einen Verband
task build     # zuschneiden -> web/data/tracks_2026.json
task og        # Share-Bild web/og.png (2400x1260) via Playwright aus der Seite mit ?og
task serve     # http://localhost:8643
```

Andere Saison: `task fetch -- --year 2025 && task build -- --year 2025`. Danach in
`web/app.js` `YEAR` umstellen.

## Datenquellen

### CS&PF

[cspf.co.uk/cs-and-pf-swims](https://cspf.co.uk/cs-and-pf-swims) listet jede erfolgreiche
Querung mit einem «Swim Track». Dahinter liegt der AIS-Feed des Pilotboots als CSV, mit
einem Fix alle ~20 Minuten. Der Track zeigt also **das Boot, nicht den Schwimmer**.
Die Seite braucht ein Session-Cookie (sonst Redirect-Schleife) und erlaubt kein CORS.
Deshalb gibt es den Python-Schritt: Die Karte selbst ist eine statische Seite und liest nur das JSON.

Die CSV-Zeiten werden als UK-Lokalzeit gelesen (BST in der Saison).

### CSA

[channelswimmingassociation.com/swims](https://www.channelswimmingassociation.com/swims?year=2026)
listet die erfolgreichen Querungen (2026: 134). Jede Detailseite (`/swim/<id>/…`) lädt ihren Track über
`/feeds/tracks-xml.php?mmsi=<Boot>&from_date=<Start>&to_date=<Ziel>`, mit exakten Zeiten inkl. Offset
und einem Fix alle ~10 Minuten. CSA-Tracks brauchen deshalb keinen Zuschnitt. IDs tragen das Präfix `c`
(`#c6084`), damit sie nicht mit CS&PF-IDs kollidieren.

Beide Listen enthalten nur erfolgreiche Querungen, keine Abbrüche.

## Zuschnitt

CS&PF liefert den Feed für ein auf die halbe Stunde gerundetes Fenster um die Querung.
`build` schiebt ein Fenster von genau der offiziellen Schwimmzeit darüber. Gewählt wird
die Lage, bei der das Ende am nächsten an der französischen Küste liegt. Bei Doppelquerungen
(`12:05:47+ 13:16:41= 25:22:28`) entscheidet das Ende der ersten Etappe.
Tracks, deren Feed vor dem Ziel abbricht oder Frankreich nie erreicht, tragen
`partial: true` und werden in der Karte mit ⚠ markiert (2026: 7 CS&PF, 5 CSA).

`hw` (Stunden ab Hochwasser Dover) und `spring` (Tidenhub, 1.0 = mittlere Springzeit)
kommen aus dem Gezeitenmodell des Simulators (`src/swim_tracks/tides.py`, Kopie aus
`speed_analysis`).

## Karte

- **Body**: Filter und Einfärbung nach Verband (CS&PF blau, CSA gelb).
- **together**: Alle starten bei T+0. Die Reihenfolge der Ankünfte entspricht der Zeitrangliste.
  Das Punkt-Histogramm links füllt sich, sobald jemand ankommt.
- **by tide**: Die Uhr läuft relativ zu HW Dover. Jeder Track startet an seiner Tidenphase.
- Einfärbung nach Schwimmzeit, Pilotboot oder Tidenhub.
- Klick auf Track, Listeneintrag oder Histogramm-Punkt: Fokus mit Stundenmarken, Karte und
  echter Uhrzeit. «This crossing only» blendet den Rest aus. Die URL `#<id>` ist teilbar.
- Tastatur: Leertaste = Play/Pause, ←/→ = ±10 min, Esc = Fokus aufheben.

## Link-Vorschau (Facebook & Co.)

Die OG-Tags in `web/index.html` zeigen auf `https://silvanm.github.io/channel-swim-swarm/`
und `…/og.png`. Das Bild ist ein echter Render der Seite: `?og` blendet Panel und Bedienung
aus, friert den Schwarm bei T+10:30 ein und legt die Titelkarte links darüber. Nach Änderungen
`task og` laufen lassen und die URL im [Sharing Debugger](https://developers.facebook.com/tools/debug/)
neu einlesen. Facebook cached das erste Bild tagelang.

## Lizenz

Code: [MIT](LICENSE), © 2026 Silvan Mühlemann.
Die Schwimm- und Trackdaten in `web/data/` stammen von [CS&PF](https://cspf.co.uk/cs-and-pf-swims)
und der [CSA](https://www.channelswimmingassociation.com/swims) und fallen nicht unter diese Lizenz.
Kartenkacheln © OpenStreetMap-Mitwirkende, © CARTO.

**Live:** https://silvanm.github.io/channel-swim-swarm/

---
Stand: 2026-10-26 · SHA: wird nach dem ersten Commit nachgetragen
