# Research site

A static, single-page website for the thesis: two side-by-side maps of Grisons with a day slider, followed by the method and results. No server code: any static host works (GitHub Pages, Cloudflare Pages, Netlify, avmap.space).

## Run it locally

```
cd research_site
python3 serve.py
```

`cd research_site` moves into this folder; `python3 serve.py` starts a small local web server. Then open http://localhost:8000. Use `serve.py` rather than `python3 -m http.server`: the slope-scale maps are read a few kilobytes at a time with HTTP "Range" requests, which Python's built-in server ignores (GitHub Pages supports them). Opening `index.html` by double-clicking does not work: browsers block `fetch()` of the data files from `file://` pages.

## Folder layout

```
index.html                 the page
assets/site.css            all styling; colour tokens at the top
assets/app.js              the two synced maps, day slider, popups and results numbers
assets/slope.js            draws a day's slope-scale GeoTIFF into map tiles, in the browser
assets/vendor/geotiff/     geotiff.js 2.1.3 (reads GeoTIFFs in the browser)
serve.py                   local web server with Range support
assets/vendor/leaflet/     Leaflet 1.9.4 (map library), kept local so the site has no CDN dependency
build/build_data.py        turns thesis outputs into the files in data/
data/                      what the page reads (about 1.3 MB)
  border.geojson             Swiss border
  grisons.geojson            canton outline
  stations.geojson           IMIS automatic weather stations the encoder was trained on
  activity.json              avalanches per day in Grisons (the bars above the slider)
  forecast/                  regional danger forecast: cells, days, levels.bin, labels.bin, probs.bin, summary.json
  bulletin/                  warning regions and their daily levels
  slope/                     slope-scale model: days/<day>.tif, avalanches/<day>.geojson, info.json
```

## Rebuild the data

```
python3 research_site/build/build_data.py
```

Needs numpy, pandas, geopandas, shapely and rasterio. The data is exactly what `phase1b_nwp_inference/danger_map_app.py` shows (same predictions file, all 117 warning regions, same bulletin rule and day convention); if you change the app, change the script the same way. The look is the site's own: cells come from the phase-2 owner raster and the colours live in `assets/app.js`. It reads:

- `data/output/input_features/NWM/gridded_predictions_seasons-2018-2019.npz` (the regional danger forecast)
- `data/clean/switzerland_boundary.gpkg` (Swiss border)
- `data/output/phase2_terrain/grids/nems4/owner.npy` and `valid.npy` (the area each grid point owns in Grisons)
- `data/raw/warning_regions_shapefile/warnregionen.shp` (warning regions)
- `data/raw/Station Inputs and Avalanche Danger Level/daily_weather_and_snowpack_inputs.csv` (bulletin labels)
- `data/output/phase3_predictions/unet_weather_arch_xl2_focal_no_zdelta_logit_cap8_with_uncoded_quiet1_wnorm/days.csv` (avalanche counts per day only)

Day convention, the same as `danger_map_app.py`: a forecast is shown on its `valid_day` and compared with the bulletin of its `issue_day`.

## Rebuild the headline result

```
python3 research_site/build/build_paired_eval.py
```

The results section shows the station-paired test from `phase1b_nwp_inference/01_evaluate_nwp.ipynb`: the same encoder (checkpoint `arch_xl2`) scores the same 9,766 test station-days once with station weather and once with weather-model weather (HS absent, no bias correction). The script runs `evaluate_nwp.evaluate` with those settings and saves both confusion matrices to `data/forecast/paired_eval.json`. Needs torch. It does not write into `phase1b_nwp_inference/results/`.

## Rebuild the slope-scale data

```
python3 research_site/build/build_slope.py
```

Reads `data/output/phase3_predictions/unet_weather_arch_xl2_focal_no_zdelta_logit_cap8_with_uncoded_quiet1_wnorm/`. Re-encodes each day's GeoTIFF from ZSTD to DEFLATE (geotiff.js cannot read ZSTD; the values are unchanged), turns `avalanches.parquet` into one outline file per day, and writes `info.json`. Days already re-encoded are skipped, so it can be rerun after more days arrive. `python3 research_site/build/build_slope.py 2019-01-14` redoes just that day.

**Size:** the day GeoTIFFs are several MB each, so all 363 days may exceed GitHub Pages' 1 GB site limit. If so, host `data/slope/` on any static host that allows cross-origin Range requests and set `SLOPE_DATA` at the top of `assets/app.js` to its URL.

## Still to add

- Links to the code and the thesis PDF, once public.
