/* Slope-scale avalanche probability: draws a day's 10 m GeoTIFF straight into Leaflet map tiles, in the browser.

   Each day is one cloud-optimised GeoTIFF in the Swiss grid (LV95, EPSG:2056) holding 8-bit codes:
   0 = no prediction, 1..255 = probability LOWEST..HIGHEST on a log scale (prediction_storage.py).
   For every map tile the layer picks the GeoTIFF overview closest to the tile's resolution, reads only the
   window under the tile (HTTP range requests), and colours each tile pixel from the code under its centre.

   Needs geotiff.js (window.GeoTIFF) and Leaflet. Exposes window.Slope.
*/
(function () {
  "use strict";

  // ---------------------------------------------------------------- WGS84 -> LV95 (swisstopo's approximate formulas, ~1 m)
  function toLV95(lat, lng) {
    const p = (lat * 3600 - 169028.66) / 10000;
    const l = (lng * 3600 - 26782.5) / 10000;
    const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
    const n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
    return [e, n];
  }

  // ---------------------------------------------------------------- colours
  // magma, the same ramp as map_app.py, as 9 stops interpolated to 256
  const MAGMA = ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55964", "#fb8761", "#fec287", "#fcfdbf"]
    .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  function magma(t) {
    const x = Math.min(1, Math.max(0, t)) * (MAGMA.length - 1);
    const i = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - i;
    return MAGMA[i].map((c, k) => Math.round(c + (MAGMA[i + 1][k] - c) * f));
  }

  // code -> RGBA. Below the bottom of the stretch: transparent, so ordinary terrain shows the base map.
  // Everything coloured is fully opaque; how much the base map shows through is set only by the
  // overlay-opacity slider (the layer's own opacity).
  function makePalette(low, high) {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let c = 1; c < 256; c++) {
      const t = (c - low) / (high - low);
      if (t <= 0) continue;
      const [r, g, b] = magma(0.15 + 0.85 * t);
      lut.set([r, g, b, 255], c * 4);
    }
    return lut;
  }

  function codeToProbability(code, info) {
    if (!code) return null;
    const share = (code - 1) / 254;
    return Math.exp(Math.log(info.lowest) + share * (Math.log(info.highest) - Math.log(info.lowest)));
  }

  // ---------------------------------------------------------------- files: one GeoTIFF per day, a few kept open
  function makeStore(base, info) {
    const open = new Map();                    // day -> Promise<{levels: [{image, factor, width, height}]}>
    const available = new Set(info.days);
    return {
      has: (day) => available.has(day),
      get(day) {
        if (!available.has(day)) return null;
        if (!open.has(day)) {
          open.set(day, (async () => {
            const tiff = await GeoTIFF.fromUrl(`${base}/days/${day}.tif`, { cacheSize: 400 });
            const count = await tiff.getImageCount();
            const full = await tiff.getImage(0);
            const levels = [];
            for (let i = 0; i < count; i++) {
              const image = i === 0 ? full : await tiff.getImage(i);
              levels.push({ image, factor: full.getWidth() / image.getWidth(), width: image.getWidth(), height: image.getHeight() });
            }
            return { levels };
          })());
          if (open.size > 6) open.delete(open.keys().next().value);      // forget the oldest day
        }
        return open.get(day);
      },
    };
  }

  // ---------------------------------------------------------------- the layer
  function createLayer(store, info, getDay, options) {
    const palette = makePalette(info.stretch_codes[0], info.stretch_codes[1]);
    const g = info.grid;

    const Layer = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        tile.width = tile.height = 256;
        const day = getDay();
        const file = store.get(day);
        if (!file) { setTimeout(() => done(null, tile), 0); return tile; }
        drawTile(tile, coords, file).then(() => done(null, tile), (err) => { console.warn(err); done(null, tile); });
        return tile;
      },
    });

    async function drawTile(tile, coords, file) {
      const { levels } = await file;
      const z = coords.z, size = 256 * Math.pow(2, z);
      // the LV95 position of every tile pixel centre
      const east = new Float64Array(256 * 256), north = new Float64Array(256 * 256);
      let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
      for (let y = 0; y < 256; y++) {
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (coords.y * 256 + y + 0.5)) / size))) * 180) / Math.PI;
        for (let x = 0; x < 256; x++) {
          const lng = ((coords.x * 256 + x + 0.5) / size) * 360 - 180;
          const [e, n] = toLV95(lat, lng);
          const k = y * 256 + x;
          east[k] = e; north[k] = n;
          if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n;
        }
      }
      const right = g.west + g.width * g.cell_size, bottom = g.north - g.height * g.cell_size;
      if (maxE < g.west || minE > right || maxN < bottom || minN > g.north) return;   // tile is off the raster

      // the coarsest overview that still has at least one cell per tile pixel
      const pixelMetres = (maxE - minE) / 256;
      let level = levels[0];
      for (const l of levels) if (l.factor * g.cell_size <= pixelMetres) level = l;
      const cell = g.cell_size * level.factor;

      const c0 = Math.max(0, Math.floor((minE - g.west) / cell)), c1 = Math.min(level.width, Math.ceil((maxE - g.west) / cell) + 1);
      const r0 = Math.max(0, Math.floor((g.north - maxN) / cell)), r1 = Math.min(level.height, Math.ceil((g.north - minN) / cell) + 1);
      if (c1 <= c0 || r1 <= r0) return;
      const [codes] = await level.image.readRasters({ window: [c0, r0, c1, r1] });
      const w = c1 - c0;

      const ctx = tile.getContext("2d");
      const out = ctx.createImageData(256, 256);
      for (let k = 0; k < 256 * 256; k++) {
        const c = Math.floor((east[k] - g.west) / cell) - c0, r = Math.floor((g.north - north[k]) / cell) - r0;
        if (c < 0 || r < 0 || c >= w || r >= r1 - r0) continue;
        const code = codes[r * w + c];
        if (!code) continue;
        out.data[k * 4] = palette[code * 4];
        out.data[k * 4 + 1] = palette[code * 4 + 1];
        out.data[k * 4 + 2] = palette[code * 4 + 2];
        out.data[k * 4 + 3] = palette[code * 4 + 3];
      }
      ctx.putImageData(out, 0, 0);
    }

    return new Layer({ tileSize: 256, updateWhenZooming: false, keepBuffer: 1, maxZoom: 18, ...options });
  }

  // the probability under one point, read from the full-resolution image
  async function valueAt(store, info, day, latlng) {
    const file = store.get(day);
    if (!file) return undefined;
    const { levels } = await file;
    const g = info.grid, [e, n] = toLV95(latlng.lat, latlng.lng);
    const c = Math.floor((e - g.west) / g.cell_size), r = Math.floor((g.north - n) / g.cell_size);
    if (c < 0 || r < 0 || c >= g.width || r >= g.height) return null;
    const [codes] = await levels[0].image.readRasters({ window: [c, r, c + 1, r + 1] });
    const code = codes[0];
    if (!code) return null;
    // files built with --web: code 1 stands for "below the colour stretch", other values are rounded to bins
    if (info.floor_code && code === info.floor_code) return { below: codeToProbability(info.stretch_codes[0], info) };
    return { p: codeToProbability(code, info), approx: !!(info.mode && info.mode.bins) };
  }

  window.Slope = { makeStore, createLayer, valueAt, magma, toLV95, codeToProbability };
})();
