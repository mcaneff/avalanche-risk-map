"""Keep the avalanche outlines of a few chosen days only, for the public site.

     python3 build/build_public_outlines.py

Reads the exact outlines from the thesis site (05 Thesis/research_site/data/slope/) and writes into this
folder's data/slope/: avalanches/ (the chosen days only) and info.json. The slope maps are not touched.
"""

import json
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
SOURCE = SITE.parent / "05 Thesis" / "research_site" / "data" / "slope"
OUT = SITE / "data" / "slope"

# the only days whose outlines are published
CURATED_DAYS = [
     "2018-12-13", "2019-01-14", "2019-02-04", "2019-04-15", "2019-04-19",
     "2019-11-24", "2019-12-14", "2019-12-23", "2019-12-25", "2019-12-28",
     "2020-02-03", "2020-02-28", "2020-03-17", "2020-03-18", "2020-04-19",
]


def read_json(path):
     return json.loads(path.read_text())


def write_json(path, data):
     path.parent.mkdir(parents=True, exist_ok=True)
     path.write_text(json.dumps(data, separators=(",", ":")))


if __name__ == "__main__":
     source_info = read_json(SOURCE / "info.json")
     all_days = source_info["avalanche_days"]
     for day in CURATED_DAYS:
          if day not in all_days:
               raise SystemExit(f"{day} has no outlines in {SOURCE}")

     # start clean: no outline of another day may be left behind from an earlier run
     (OUT / "avalanches").mkdir(parents=True, exist_ok=True)
     for old in (OUT / "avalanches").glob("*.geojson"):
          old.unlink()

     kept = 0
     total = 0
     for day in all_days:
          collection = read_json(SOURCE / "avalanches" / f"{day}.geojson")
          total += len(collection["features"])
          if day in CURATED_DAYS:
               write_json(OUT / "avalanches" / f"{day}.geojson", collection)
               kept += len(collection["features"])

     info = dict(source_info)
     info["avalanche_days"] = sorted(CURATED_DAYS)
     write_json(OUT / "info.json", info)
     print(f"outlines kept: {len(CURATED_DAYS)} days, {kept} of {total} polygons ({100 * kept / total:.1f}%)")
