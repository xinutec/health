#!/usr/bin/env python3
"""Render an EpisodeGeometry GeoJSON on OSM tiles to judge the Map-tab render.
Throwaway map-QA tool. Optional bbox crop: lonmin,latmin,lonmax,latmax."""
import json
import sys

from staticmap import CircleMarker, Line, StaticMap

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ep-0624.geojson"
out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/ep-0624.png"
bbox = [float(x) for x in sys.argv[3].split(",")] if len(sys.argv) > 3 else None

KIND_COLOR = {
    "snapped": "#1f77b4",    # rail — blue
    "smoothed": "#2ca02c",   # smoothed walk — green
    "raw": "#ff7f0e",        # raw GPS — orange
    "matched": "#9467bd",    # road-matched — purple
    "tentative": "#d62728",  # tentative — red
    "anchor": "#111111",     # stationary pin — black
}

fc = json.load(open(src))


def in_bbox(lon, lat):
    if not bbox:
        return True
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


m = StaticMap(1500, 1600, url_template="https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", padding_x=60, padding_y=60)
n_lines = n_pts = 0
for f in fc["features"]:
    g, p = f["geometry"], f["properties"]
    col = KIND_COLOR.get(p.get("kind", "raw"), "#777777")
    if g["type"] == "LineString":
        coords = [(lon, lat) for lon, lat in g["coordinates"] if in_bbox(lon, lat)]
        if len(coords) >= 2:
            m.add_line(Line(coords, col, 4))
            n_lines += 1
    elif g["type"] == "Point":
        lon, lat = g["coordinates"]
        if in_bbox(lon, lat):
            m.add_marker(CircleMarker((lon, lat), col, 18))
            m.add_marker(CircleMarker((lon, lat), "#ffffff", 8))
            n_pts += 1

img = m.render()
img.save(out)
print(f"wrote {out}  ({n_lines} lines, {n_pts} anchors)")
