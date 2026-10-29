/* The map and the numbers on the page. Everything is read from data/ (written by build/build_data.py).

   Two Leaflet maps sit side by side, each showing the layer picked in its own menu, with pan and zoom locked
   together. A layer is a GeoJSON layer restyled on every day change.
*/
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants
  // Colour-blind-safe danger scale from danger_map_app.py: varies along the blue-yellow axis.
  // Forecast and bulletin use the same hues so the two sides of the divider compare directly.
  const PALETTE = ["#9BC4E2", "#2E6DA4", "#E0A32A", "#B3382B", "#3A0A12"];

  // Level 5's near-black disappears on a dark base map, so it is drawn as bright red stripes on that dark red:
  // still the darkest, most alarming class, but unmistakable on any background (the EAWS scale also patterns 5).
  const STRIPE_LIGHT = "#FF6B5E", STRIPE_DARK = "#4A0B16";
  function mapFill(k) { return k === 4 ? "url(#danger-5)" : PALETTE[k]; }
  function swatch(k) {
    return k === 4 ? `repeating-linear-gradient(45deg, ${STRIPE_LIGHT} 0 3px, ${STRIPE_DARK} 3px 7px)` : PALETTE[k];
  }
  function addPatterns() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.innerHTML = `<defs><pattern id="danger-5" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">` +
      `<rect width="8" height="8" fill="${STRIPE_DARK}"/><rect width="3.5" height="8" fill="${STRIPE_LIGHT}"/></pattern></defs>`;
    document.body.appendChild(svg);
  }
  const LEVEL_NAMES = ["Low", "Moderate", "Considerable", "High", "Very high"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const LAYERS = {
    forecast: { title: "Regional danger forecast", desc: "Model danger level for each 4.45 km weather-model cell." },
    bulletin: { title: "Official bulletin", desc: "SLF danger level per warning region. Dashed: no label that day." },
    slope:    { title: "Slope-scale avalanche probability",
                desc: "Chance each 10 m cell releases that day. Only the likeliest fifth of the terrain is coloured." },
    off:      { title: "", desc: "Base map only." },
  };

  const BASES = {
    dark:  { button: "Dark", layer: "ch.swisstopo.pixelkarte-grau", className: "tiles-dark" },
    topo:  { button: "Swiss topo", layer: "ch.swisstopo.pixelkarte-farbe" },
    sat:   { button: "Satellite", layer: "ch.swisstopo.swissimage" },
  };

  // Where the slope-scale files live. Relative = inside this site. If they outgrow GitHub Pages, put them on any
  // static host that allows cross-origin Range requests and set the full URL here, e.g. "https://…/slope".
  const SLOPE_DATA = "data/slope";

  const state = { day: 0, left: "forecast", right: "slope", base: "dark", clicked: null, full: null, stations: true, avalanches: true, grid: false, opacity: 1 };
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- data
  async function loadData() {
    const json = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
    const bin = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.arrayBuffer(); })
                               .then((b) => new Uint8Array(b));
    const [days, cells, levels, labels, probs, regions, bulletin, border, domain, activity, summary, stations] = await Promise.all([
      json("data/forecast/days.json"), json("data/forecast/cells.geojson"),
      bin("data/forecast/levels.bin"), bin("data/forecast/labels.bin"), bin("data/forecast/probs.bin"),
      json("data/bulletin/regions.geojson"), json("data/bulletin/levels.json"),
      json("data/border.geojson"), json("data/grisons.geojson"),
      json("data/activity.json"), json("data/forecast/summary.json"), json("data/stations.geojson"),
    ]);
    const paired = await json("data/forecast/paired_eval.json").catch(() => null);
    // the slope-scale run is optional: without data/slope the page still works, with that option greyed out
    const slope = await json(`${SLOPE_DATA}/info.json`).catch(() => null);
    const regionIndex = new Map(bulletin.regions.map((id, i) => [id, i]));
    return { days, cells, levels, labels, probs, regions, bulletin, regionIndex, border, domain, activity, summary, stations, slope, paired,
             nCells: days.cells.length, nDays: days.days.length };
  }

  // ---------------------------------------------------------------- small helpers
  function parseDay(s) { const [y, m, d] = s.split("-").map(Number); return { y, m: m - 1, d }; }
  function dayLabel(s) { const t = parseDay(s); return String(t.d).padStart(2, "0") + " " + MONTHS[t.m] + " " + t.y; }
  function seasonLabel(s) {
    const t = parseDay(s); const start = t.m >= 8 ? t.y : t.y - 1;
    return "Winter " + start + "/" + String(start + 1).slice(2);
  }
  function pct(x, digits = 1) { return (x * 100).toFixed(digits) + "%"; }
  function fmt(n) { return n.toLocaleString("en-US"); }

  function forecastLevel(D, day, i) { return D.levels[day * D.nCells + i]; }          // 0..4, 255 = none
  function cellLabel(D, day, i) { return D.labels[day * D.nCells + i]; }              // 0..4, 255 = none

  // the app's day_stats: every cell with both a forecast and a bulletin label that day
  function dayStats(D, day) {
    let n = 0, exact = 0, safe = 0, under = 0;
    for (let i = 0; i < D.nCells; i++) {
      const p = forecastLevel(D, day, i), l = cellLabel(D, day, i);
      if (p > 4 || l > 4) continue;
      const d = p - l; n++;
      if (d === 0) exact++;
      if (d === 0 || d === 1) safe++;
      if (d < 0) under++;
    }
    return n ? { n, exact: exact / n, safe: safe / n, under: under / n } : null;
  }
  function bulletinLevel(D, day, regionId) {                                          // 1..5, 0 = none
    const k = D.regionIndex.get(regionId);
    return k === undefined ? 0 : Number(D.bulletin.levels[day][k]);
  }

  // point in polygon (ray casting) for GeoJSON Polygon / MultiPolygon with holes
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inGeometry(x, y, g) {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    return polys.some((rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h)));
  }
  function featureAt(fc, latlng) {
    return fc.features.find((f) => inGeometry(latlng.lng, latlng.lat, f.geometry)) || null;
  }

  // ---------------------------------------------------------------- maps
  // Two maps side by side, each with its own layer. Pan or zoom one and the other follows.
  const SIDES = ["left", "right"];

  function buildMaps(D) {
    const forecastStyle = (f) => {
      const lvl = forecastLevel(D, state.day, f.properties.i);
      if (lvl > 4) return { fillOpacity: 0, color: "#5B6573", weight: 0.5, opacity: 0.6 };
      return { fillColor: mapFill(lvl), fillOpacity: (lvl === 4 ? 0.9 : 0.62) * state.opacity, color: "rgba(11,13,17,0.55)", weight: 0.6, opacity: 1 };
    };
    const bulletinStyle = (f) => {
      const lvl = bulletinLevel(D, state.day, f.properties.id);
      if (!lvl) return { fillOpacity: 0, color: "#8C96A3", weight: 1, dashArray: "4 4", opacity: 0.9 };
      return { fillColor: mapFill(lvl - 1), fillOpacity: (lvl === 5 ? 0.85 : 0.55) * state.opacity, color: "#FFFFFF", weight: 1.4, dashArray: null, opacity: 0.9 };
    };

    const M = { maps: {}, bases: {}, layers: {}, slope: {}, avalanches: {} };
    M.store = D.slope ? Slope.makeStore(SLOPE_DATA, D.slope) : null;
    const phone = window.innerWidth <= 760;
    for (const side of SIDES) {
      // wheel zoom: react to the wheel sooner (debounce 20 ms, default 40) and move further per notch
      // (40 px of wheel per zoom level, default 60); fractional steps keep trackpads smooth
      const map = L.map("map-" + side, { zoomControl: side === "left", zoomSnap: 0.25, zoomDelta: 0.5,
        wheelDebounceTime: 20, wheelPxPerZoomLevel: 40, minZoom: 7, maxZoom: 16 });
      M.maps[side] = map;
      M.bases[side] = {};
      for (const [key, b] of Object.entries(BASES)) {
        M.bases[side][key] = L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${b.layer}/default/current/3857/{z}/{x}/{y}.jpeg`,
          { maxZoom: 16, maxNativeZoom: 18, className: b.className || "", attribution: "&copy; swisstopo" });
      }
      M.layers[side] = {
        forecast: L.geoJSON(D.cells, { interactive: false, style: forecastStyle }),
        bulletin: L.geoJSON(D.regions, { interactive: false, style: bulletinStyle }),
      };
      // slope-scale probability (drawn from the day's GeoTIFF) and the mapped avalanches of that day
      map.createPane("slope").style.zIndex = 380;
      if (M.store) M.slope[side] = Slope.createLayer(M.store, D.slope, () => D.days.days[state.day], { pane: "slope" });
      map.createPane("avalanches").style.zIndex = 440;
      // the avalanche being visited, drawn over the others
      M.focus = M.focus || {};
      M.focus[side] = L.geoJSON(null, { pane: "avalanches", interactive: false,
        style: { color: "#FFE14D", weight: 3, opacity: 1, fillColor: "#FFE14D", fillOpacity: 0.15 } }).addTo(map);
      M.avalanches[side] = L.geoJSON(null, { pane: "avalanches", interactive: false,
        style: { color: "#00E6FF", weight: 1.6, opacity: 1, fillColor: "#00E6FF", fillOpacity: 0.12 } });
      map.createPane("outline").style.zIndex = 430;
      // the weather-model grid: the 4.45 km cell each weather point stands for, outlines only, on any layer
      map.createPane("grid").style.zIndex = 425;
      M.grid = M.grid || {};
      M.grid[side] = L.geoJSON(D.cells, { pane: "grid", interactive: false,
        style: { color: "#FFFFFF", weight: 0.8, opacity: 0.7, fill: false } });
      L.geoJSON(D.border, { pane: "outline", interactive: false,
        style: { color: "#E8ECF1", weight: 1.2, opacity: 0.45, fill: false } }).addTo(map);
      const outline = L.geoJSON(D.domain, { pane: "outline", interactive: false,
        style: { color: "#FFFFFF", weight: 1.6, opacity: 0.85, fill: false } }).addTo(map);
      // IMIS automatic weather stations: the stations the encoder was trained on, on top of everything
      map.createPane("stations").style.zIndex = 450;
      M.stations = M.stations || {};
      M.stations[side] = L.geoJSON(D.stations, {
        pane: "stations",
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { pane: "stations", radius: 4.5, weight: 1.5,
          color: "#0B0D11", fillColor: "#FFFFFF", fillOpacity: 1 }),
        onEachFeature: (f, layer) => layer.bindTooltip(
          `<b>${f.properties.code}</b> · IMIS station${f.properties.elev ? ` · ${fmt(f.properties.elev)} m` : ""}`,
          { direction: "top", offset: [0, -4] }),
      });
      map.fitBounds(outline.getBounds(), { padding: phone ? [10, 10] : [24, 24] });
      map.setMaxBounds(outline.getBounds().pad(1.2));
    }

    // Keep the two views locked together. The map being moved leads; the other follows.
    //  - `following` blocks the echo: while one map is being set from the other, the follower's own move
    //    events (fired synchronously inside setView) are ignored, so it never pushes back and never
    //    interrupts the leader's animation (a fly-to, a wheel zoom).
    //  - zoomSnap is lifted on the follower while it is set, so it lands on exactly the leader's zoom
    //    mid-animation instead of rounding to the nearest quarter level.
    //  - a wheel zoom is mirrored as an animated zoom starting at the same moment, so both glide together.
    let following = false;
    const follow = (other, center, zoom, animate) => {
      following = true;
      const snap = other.options.zoomSnap;
      other.options.zoomSnap = 0;
      other.setView(center, zoom, { animate });
      other.options.zoomSnap = snap;
      following = false;
    };
    for (const side of SIDES) {
      const map = M.maps[side], other = M.maps[side === "left" ? "right" : "left"];
      map.on("zoomanim", (e) => {
        if (following || (other._animatingZoom && other._animateToZoom === e.zoom)) return;
        follow(other, e.center, e.zoom, true);
      });
      map.on("move", () => {
        if (following || map._animatingZoom) return;               // wheel zooms are handled above
        follow(other, map.getCenter(), map.getZoom(), false);
      });
    }
    return M;
  }

  // ---------------------------------------------------------------- controls
  function segmented(container, options, current, onPick) {
    container.innerHTML = "";
    for (const [key, o] of Object.entries(options)) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.button;
      b.setAttribute("aria-pressed", String(key === current));
      if (o.disabled) { b.disabled = true; b.title = "Coming soon"; }
      b.addEventListener("click", () => onPick(key));
      container.appendChild(b);
    }
  }

  function applyLayers(M) {
    for (const side of SIDES) {
      const map = M.maps[side];
      for (const [key, layer] of Object.entries(M.layers[side])) {
        const want = state[side] === key;
        if (want && !map.hasLayer(layer)) layer.addTo(map);
        if (!want && map.hasLayer(layer)) map.removeLayer(layer);
      }
      const slope = M.slope[side];
      if (slope) {
        if (state[side] === "slope" && !map.hasLayer(slope)) slope.addTo(map);
        if (state[side] !== "slope" && map.hasLayer(slope)) map.removeLayer(slope);
      }
      $("sel-" + side).value = state[side];
      $("desc-" + side).textContent = LAYERS[state[side]].desc;
    }
  }

  function wireLayerSelects(M) {
    for (const side of SIDES) {
      const select = $("sel-" + side);
      const off = (k, o) => o.disabled || (k === "slope" && !M.store);
      select.innerHTML = Object.entries(LAYERS).map(([k, o]) =>
        `<option value="${k}"${off(k, o) ? " disabled" : ""}>${o.title || "Nothing"}${off(k, o) ? " (not built yet)" : ""}</option>`).join("");
      if (state[side] === "slope" && !M.store) state[side] = "bulletin";
      select.addEventListener("change", () => { state[side] = select.value; applyLayers(M); });
    }
  }

  function applyBase(M) {
    for (const side of SIDES) {
      for (const [key, layer] of Object.entries(M.bases[side])) {
        if (key === state.base) { if (!M.maps[side].hasLayer(layer)) layer.addTo(M.maps[side]); }
        else if (M.maps[side].hasLayer(layer)) M.maps[side].removeLayer(layer);
      }
    }
    segmented($("seg-base"), BASES, state.base, (k) => { state.base = k; applyBase(M); });
  }

  function applyGrid(M) {
    for (const side of SIDES) {
      const layer = M.grid[side], map = M.maps[side];
      if (state.grid && !map.hasLayer(layer)) layer.addTo(map);
      if (!state.grid && map.hasLayer(layer)) map.removeLayer(layer);
    }
    $("toggle-grid").setAttribute("aria-pressed", String(state.grid));
  }

  function applyStations(M) {
    for (const side of SIDES) {
      const layer = M.stations[side], map = M.maps[side];
      if (state.stations && !map.hasLayer(layer)) layer.addTo(map);
      if (!state.stations && map.hasLayer(layer)) map.removeLayer(layer);
    }
    const b = $("toggle-stations");
    b.setAttribute("aria-pressed", String(state.stations));
  }

  // the mapped avalanches of the shown day, as outlines on both maps; each day's file is fetched once
  const avalancheCache = new Map();
  async function applyAvalanches(M, D) {
    const day = D.days.days[state.day];
    const has = D.slope && D.slope.avalanche_days.includes(day);
    let data = null;
    if (state.avalanches && has) {
      if (!avalancheCache.has(day)) avalancheCache.set(day, fetchAvalanches(day));
      data = await avalancheCache.get(day);
      if (D.days.days[state.day] !== day) return;              // the day changed while this one was loading
    }
    for (const side of SIDES) {
      const layer = M.avalanches[side], map = M.maps[side];
      layer.clearLayers();
      if (data) layer.addData(data);
      if (state.avalanches && !map.hasLayer(layer)) layer.addTo(map);
      if (!state.avalanches && map.hasLayer(layer)) map.removeLayer(layer);
    }
    $("toggle-avalanches").setAttribute("aria-pressed", String(state.avalanches));
    $("toggle-avalanches").disabled = !D.slope;
  }

  // ---------------------------------------------------------------- stepping through one day's avalanches
  // Each outline in the day's file is one mapped avalanche area (touching avalanches were merged when the
  // outlines were drawn). They are visited largest first; "Go to avalanches" first frames them all.
  const tour = { day: null, list: [], at: -1 };

  // one day's outlines; a missing or broken file counts as "no avalanches" rather than breaking the page
  function fetchAvalanches(day) {
    return fetch(`${SLOPE_DATA}/avalanches/${day}.geojson`)
      .then((r) => (r.ok ? r.json() : { type: "FeatureCollection", features: [] }))
      .catch(() => ({ type: "FeatureCollection", features: [] }));
  }

  function boundsOf(geometry) { return L.geoJSON(geometry).getBounds(); }

  async function loadTour(D) {
    const day = D.days.days[state.day];
    if (tour.day === day) return tour;
    tour.day = day; tour.list = []; tour.at = -1;
    if (D.slope && D.slope.avalanche_days.includes(day)) {
      if (!avalancheCache.has(day)) avalancheCache.set(day, fetchAvalanches(day));
      const fc = await avalancheCache.get(day);
      if (tour.day !== day) return tour;
      tour.list = fc.features.map((f) => {
        const b = boundsOf(f.geometry);
        const size = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
        return { feature: f, bounds: b, size };
      }).sort((a, b) => b.size - a.size);
    }
    return tour;
  }

  function updateTourControls() {
    const n = tour.list.length;
    const off = !n || !state.avalanches;                        // the tour only works while avalanches are shown
    $("aval-all").disabled = off;
    $("aval-prev").disabled = $("aval-next").disabled = off;
    $("aval-count").textContent = !n ? "none" : tour.at < 0 ? `${n} mapped` : `${tour.at + 1} / ${n}`;
  }

  function showTour(M, D) {
    if (!state.avalanches) return;
    for (const side of SIDES) M.focus[side].clearLayers();
    const map = M.maps.left;                                    // the right map follows through the sync
    const padding = [40, 40];
    if (tour.at < 0) {
      // a fresh bounds object: L.latLngBounds(existing) returns the same object, and extending it would
      // silently grow the first avalanche's own bounds
      const first = tour.list[0].bounds;
      const all = tour.list.reduce((b, t) => b.extend(t.bounds), L.latLngBounds(first.getSouthWest(), first.getNorthEast()));
      map.flyToBounds(all, { padding, maxZoom: 13, duration: 0.8 });
    } else {
      const t = tour.list[tour.at];
      for (const side of SIDES) M.focus[side].addData(t.feature);
      map.flyToBounds(t.bounds.pad(0.6), { padding, maxZoom: 15, duration: 0.8 });
    }
    updateTourControls();
  }

  function wireTour(M, D) {
    $("aval-all").addEventListener("click", async () => { await loadTour(D); if (tour.list.length) { tour.at = -1; showTour(M, D); } });
    const step = async (delta) => {
      await loadTour(D);
      const n = tour.list.length;
      if (!n) return;
      tour.at = tour.at < 0 ? (delta > 0 ? 0 : n - 1) : (tour.at + delta + n) % n;
      showTour(M, D);
    };
    $("aval-prev").addEventListener("click", () => step(-1));
    $("aval-next").addEventListener("click", () => step(1));
  }

  // a new day: forget the old tour, count the new day's avalanches
  async function resetTour(M, D) {
    tour.day = null; tour.list = []; tour.at = -1;
    for (const side of SIDES) M.focus[side].clearLayers();
    updateTourControls();
    await loadTour(D);
    updateTourControls();
  }

  function buildLegend() {
    $("legend").innerHTML = `<div class="legend-row">` +
      PALETTE.map((c, i) => `<span class="sw"><i style="background:${swatch(i)}"></i>${i + 1} ${LEVEL_NAMES[i]}</span>`).join("") +
      `<span class="sw"><i class="none"></i>No bulletin label</span>` +
      `<span class="sw"><i class="station"></i>IMIS weather station</span></div>` +
      `<div class="legend-row"><span class="sw"><i class="magma"></i>Slope-scale probability, low to high</span>` +
      `<span class="sw"><i class="aval"></i>Mapped avalanche (SLF)</span></div>`;
  }

  // ---------------------------------------------------------------- day strip
  function drawStrip(D) {
    const canvas = $("strip");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const counts = D.activity.counts;
    const maxLog = Math.log1p(Math.max(1, ...counts.filter((c) => c != null)));
    const bw = w / D.nDays;
    for (let i = 0; i < D.nDays; i++) {
      const c = counts[i];
      const bh = i === state.day ? h : Math.max(2, (Math.log1p(c || 0) / maxLog) * (h - 2));
      ctx.fillStyle = i === state.day ? "#00E6FF" : c == null ? "#1C222A" : c > 0 ? "#5B6573" : "#262C35";
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.6), bh);
    }
    // a thin gap marks the summer between the two winters
    for (let i = 1; i < D.nDays; i++) {
      const a = parseDay(D.days.days[i - 1]), b = parseDay(D.days.days[i]);
      if (Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d) > 86400000 * 2) {
        ctx.fillStyle = "#0B0D11"; ctx.fillRect(i * bw - 2, 0, 3, h);
      }
    }
  }

  // ---------------------------------------------------------------- popup
  function popupHtml(D, latlng) {
    const day = state.day;
    const cell = featureAt(D.cells, latlng);
    const region = featureAt(D.regions, latlng);
    if (!cell && !region) return null;
    let html = `<div class="pop-h">${dayLabel(D.days.days[day])}</div>`;
    if (cell) {
      const i = cell.properties.i;
      const lvl = forecastLevel(D, day, i);
      html += `<div class="pop-h" style="margin-top:8px">Regional danger forecast</div>`;
      if (lvl > 4) html += `<div class="pop-big">No forecast this day</div>`;
      else {
        html += `<div class="pop-big"><i style="background:${swatch(lvl)}"></i>${lvl + 1} ${LEVEL_NAMES[lvl]}</div><div class="bars">`;
        for (let k = 0; k < 5; k++) {
          const p = D.probs[(day * D.nCells + i) * 5 + k] / 255;
          html += `<span>${k + 1}</span><span class="b"><span style="width:${(p * 100).toFixed(1)}%;background:${swatch(k)}"></span></span><span>${Math.round(p * 100)}%</span>`;
        }
        html += `</div>`;
      }
      const l = cellLabel(D, day, i);
      if (lvl <= 4 && l <= 4) {
        const verdict = lvl === l ? "exact" : `${lvl < l ? "under" : "over"} by ${Math.abs(lvl - l)}`;
        html += `<div style="margin-top:8px">Bulletin for this cell: <b>${l + 1} ${LEVEL_NAMES[l]}</b> · ` +
                `<span style="color:${lvl < l ? "#FF8A80" : "inherit"}">${verdict}</span></div>`;
      }
      html += `<div class="muted" style="font-size:12px;margin-top:6px">Grid cell ${cell.properties.id} at ${fmt(cell.properties.asl)} m</div>`;
    }
    if (region) {
      const b = bulletinLevel(D, day, region.properties.id);
      html += `<hr class="pop-sep"><div class="pop-h">Official bulletin · ${region.properties.name}</div>`;
      html += b ? `<div class="pop-big"><i style="background:${swatch(b - 1)}"></i>${b} ${LEVEL_NAMES[b - 1]}</div>`
                : `<div class="muted">No bulletin label for this region that day</div>`;
      if (!region.properties.grid) html += `<div class="muted" style="font-size:12px">Outside the model domain</div>`;
    }
    html += `<hr class="pop-sep"><div class="pop-h">Slope-scale probability</div><div class="pop-slope"><span class="muted">Reading…</span></div>`;
    return html;
  }

  // the slope-scale value needs a read from the GeoTIFF, so it is filled in once it arrives
  async function fillSlope(M, D, el, latlng, token) {
    if (!M.store) return;
    const day = D.days.days[state.day];
    const box = () => (infoToken === token ? el.querySelector(".pop-slope") : null);   // null once another click replaced it
    if (!M.store.has(day)) { if (box()) box().innerHTML = `<span class="muted">No slope-scale map this day</span>`; return; }
    const p = await Slope.valueAt(M.store, D.slope, day, latlng).catch(() => undefined);
    if (D.days.days[state.day] !== day || !box()) return;
    const aval = state.avalanches && M.avalanches.left.getLayers().some((l) => inGeometry(latlng.lng, latlng.lat, l.feature.geometry));
    const show = (x) => (x < 0.001 ? "&lt;0.1" : (x * 100).toFixed(x < 0.1 ? 1 : 0)) + "%";
    const cell = `${D.slope.grid.cell_size} m`;
    const value = p == null ? null : p.below != null ? `below ${show(p.below)}` : (p.approx ? "about " : "") + show(p.p);
    box().innerHTML = value == null ? `<span class="muted">Outside the slope-scale map</span>`
      : `<div class="pop-big">${value} <span class="muted" style="font-weight:400;font-size:13px">chance this ${cell} cell releases</span></div>` +
        (aval ? `<div style="color:#00E6FF">A mapped avalanche covers this cell</div>` : "");
  }

  // The numbers for a clicked point live in the panel to the right of the day controls, never over the map.
  // A small ring marks the point on both maps. Every click replaces the contents; the x clears it.
  // Changing the day refreshes it for the same point.
  let infoToken = 0;
  function wireInfo(M, D) {
    const el = $("info"), marks = {};
    const empty = el.innerHTML;
    for (const side of SIDES) {
      M.maps[side].createPane("mark").style.zIndex = 460;
      marks[side] = L.circleMarker([0, 0], { pane: "mark", radius: 7, weight: 2.5, color: "#FFE14D", fill: false, interactive: false });
    }
    const clear = () => {
      state.clicked = null; infoToken++;
      el.innerHTML = empty;
      for (const side of SIDES) M.maps[side].removeLayer(marks[side]);
    };
    const render = () => {
      if (!state.clicked) return clear();
      const { latlng } = state.clicked;
      const html = popupHtml(D, latlng);
      if (!html) return clear();
      const token = ++infoToken;
      for (const side of SIDES) marks[side].setLatLng(latlng).addTo(M.maps[side]);
      el.innerHTML = `<button class="info-close" type="button" aria-label="Clear the clicked point">&times;</button>` +
        `<p class="caps" style="margin-bottom:4px">Clicked point</p>` + html;
      el.querySelector(".info-close").addEventListener("click", (e) => { e.stopPropagation(); clear(); });
      fillSlope(M, D, el, latlng, token);
    };
    for (const side of SIDES) {
      M.maps[side].on("click", (e) => { state.clicked = { side, latlng: e.latlng }; render(); });
    }
    return { refresh: render, clear };
  }

  // ---------------------------------------------------------------- full screen, one map at a time
  function wireFullscreen(M, D, popups) {
    const set = (side, on) => {
      const panel = $("panel-" + side);
      panel.classList.toggle("is-full", on);
      document.body.classList.toggle("has-full", on);
      panel.querySelector(".fs-btn").setAttribute("aria-pressed", String(on));
      panel.querySelector(".fs-btn").setAttribute("aria-label", on ? "Exit full screen" : `Show the ${side} map full screen`);
      state.full = on ? side : null;
      // Leaflet must re-measure its container after it changes size, keeping the same centre
      for (const s2 of SIDES) { const c = M.maps[s2].getCenter(); M.maps[s2].invalidateSize(false); M.maps[s2].setView(c, M.maps[s2].getZoom(), { animate: false }); }
    };
    for (const side of SIDES) {
      const panel = $("panel-" + side);
      panel.querySelector(".fs-btn").addEventListener("click", () => set(side, !panel.classList.contains("is-full")));
      panel.querySelector(".fs-prev").addEventListener("click", () => setDay(M, D, popups, state.day - 1));
      panel.querySelector(".fs-next").addEventListener("click", () => setDay(M, D, popups, state.day + 1));
    }
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.full) set(state.full, false); });
  }

  // ---------------------------------------------------------------- day changes
  function setDay(M, D, popup, day) {
    state.day = Math.max(0, Math.min(D.nDays - 1, day));
    const s = D.days.days[state.day];
    $("day").value = state.day;
    $("day-label").textContent = dayLabel(s);
    $("season-label").textContent = seasonLabel(s);
    const c = D.activity.counts[state.day];
    $("count-label").textContent = c == null ? "–" : fmt(c);
    const st = dayStats(D, state.day);
    $("day-stats").innerHTML = st
      ? `Agreement today: <b>exact ${pct(st.exact, 0)}</b> · safe ${pct(st.safe, 0)} · <span class="under">under ${pct(st.under, 0)}</span> · ${st.n} labelled cells`
      : "No bulletin labels this day";
    for (const side of SIDES) for (const layer of Object.values(M.layers[side])) layer.setStyle(layer.options.style);
    for (const side of SIDES) if (M.slope[side] && M.maps[side].hasLayer(M.slope[side])) M.slope[side].redraw();
    applyAvalanches(M, D);
    resetTour(M, D);
    drawStrip(D);
    if (state.clicked) popup.refresh();
    for (const el of document.querySelectorAll(".fs-date")) el.textContent = dayLabel(s);
    history.replaceState(null, "", "#" + s);
  }

  function wireDays(M, D, popup) {
    const input = $("day");
    input.max = D.nDays - 1;
    input.addEventListener("input", () => setDay(M, D, popup, Number(input.value)));
    $("prev").addEventListener("click", () => setDay(M, D, popup, state.day - 1));
    $("next").addEventListener("click", () => setDay(M, D, popup, state.day + 1));
    $("strip").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      setDay(M, D, popup, Math.floor(((e.clientX - r.left) / r.width) * D.nDays));
    });
    window.addEventListener("resize", () => drawStrip(D));
  }

  function wireJumps(M, D, popup) {
    const ranked = D.activity.counts.map((c, i) => [c || 0, i]).sort((a, b) => b[0] - a[0]).slice(0, 3);
    $("jumps").innerHTML = "";
    // the app's "Peak danger day": the day with the highest mean forecast level
    let peak = 0, best = -1;
    for (let d = 0; d < D.nDays; d++) {
      let sum = 0, n = 0;
      for (let i = 0; i < D.nCells; i++) { const p = forecastLevel(D, d, i); if (p <= 4) { sum += p; n++; } }
      if (n && sum / n > best) { best = sum / n; peak = d; }
    }
    const pb = document.createElement("button");
    pb.type = "button";
    pb.innerHTML = `Peak danger day<b>${dayLabel(D.days.days[peak])}</b>`;
    pb.addEventListener("click", () => { setDay(M, D, popup, peak); $("map").scrollIntoView(); });
    $("jumps").appendChild(pb);
    for (const [count, i] of ranked) {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `${dayLabel(D.days.days[i])}<b>${fmt(count)}</b>`;
      b.setAttribute("aria-label", `${dayLabel(D.days.days[i])}, ${count} avalanches: show on the map`);
      b.addEventListener("click", () => { setDay(M, D, popup, i); $("map").scrollIntoView(); });
      $("jumps").appendChild(b);
    }
    const label = document.createElement("span");
    label.className = "muted";
    label.style.cssText = "align-self:center;font-size:14px";
    label.textContent = "The other three are the largest avalanche days. Click to view.";
    $("jumps").appendChild(label);
  }

  // ---------------------------------------------------------------- results
  // Results: the station-paired test (data/forecast/paired_eval.json, from build/build_paired_eval.py).
  function drawMatrix(el, m) {
    let html = `<div></div>` + [1, 2, 3, 4, 5].map((k) => `<div class="ax">${k}</div>`).join("");
    m.forEach((row, r) => {
      const total = row.reduce((a, b) => a + b, 0);
      html += `<div class="ax row">${r + 1}</div>`;
      row.forEach((v, c) => {
        const p = total ? v / total : 0;
        const base = r === c ? "0,230,255" : "222,73,104";
        html += `<div class="c" style="background:rgba(${base},${(0.06 + p * 0.8).toFixed(2)});color:${p > 0.45 ? "#0B0D11" : "#C9D0D8"}" ` +
                `title="${Math.round(p * 100)}% of true level ${r + 1}">${fmt(v)}</div>`;
      });
    });
    el.innerHTML = html;
  }

  function rates(m) {
    let n = 0, exact = 0, safe = 0, under = 0;
    m.forEach((row, r) => row.forEach((v, c) => {
      n += v; if (r === c) exact += v; if (c === r || c === r + 1) safe += v; if (c < r) under += v;
    }));
    return { n, exact: exact / n, safe: safe / n, under: under / n };
  }

  function buildResults(D) {
    const P = D.paired;
    if (!P) { $("results").querySelector(".narrow").textContent = "Paired evaluation not built yet (build/build_paired_eval.py)."; return; }
    const S = P.station, N = P.nwp, ms = S.confusion_matrix, mn = N.confusion_matrix;
    const rs = rates(ms), rn = rates(mn);
    const pts = (a, b) => `${((b - a) * 100).toFixed(1)} pts`;
    $("paired-n").textContent = fmt(P.rows);
    $("stats").innerHTML = [
      [pct(S.accuracy), "Accuracy with station weather"],
      [pct(N.accuracy), `Accuracy with weather-model weather (${pts(S.accuracy, N.accuracy)})`],
      [`${pct(S.balanced_acc, 0)} → ${pct(N.balanced_acc, 0)}`, "Balanced accuracy, each level weighted equally"],
      [pct(rn.safe), "Weather-model forecast exact or one level more cautious"],
    ].map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

    drawMatrix($("matrix-station"), ms);
    drawMatrix($("matrix-nwp"), mn);
    $("cap-station").textContent = `accuracy ${S.accuracy.toFixed(3)} · macro-F1 ${S.macro_f1.toFixed(3)} · balanced ${S.balanced_acc.toFixed(3)}`;
    $("cap-nwp").textContent = `accuracy ${N.accuracy.toFixed(3)} · macro-F1 ${N.macro_f1.toFixed(3)} · balanced ${N.balanced_acc.toFixed(3)}`;

    const rowN = (m, r) => m[r].reduce((a, b) => a + b, 0);
    const recall = (m, r) => (rowN(m, r) ? m[r][r] / rowN(m, r) : 0);
    $("findings").innerHTML = [
      `Swapping the station for the weather model costs ${pts(N.accuracy, S.accuracy).replace("-", "")} of accuracy (${pct(S.accuracy)} to ${pct(N.accuracy)}) and ${pts(N.balanced_acc, S.balanced_acc).replace("-", "")} of balanced accuracy: the signal survives without a station, at a price.`,
      `The price is paid at the dangerous end. On level 4 days the station-driven model is right ${pct(recall(ms, 3), 0)} of the time, the weather-model one ${pct(recall(mn, 3), 0)} (${fmt(rowN(mn, 3))} station-days).`,
      `With weather-model input it is too low on ${pct(rn.under)} of station-days (station input: ${pct(rs.under)}), and exact or one level more cautious on ${pct(rn.safe)} (station: ${pct(rs.safe)}).`,
      `Level 5 occurs on only ${fmt(rowN(ms, 4))} station-days in the test winters, too few to measure: neither arm's level-5 numbers mean anything.`,
      `Checkpoint ${P.config.tags.join(", ")}, snow height absent, no bias correction. Station-days in one warning region share a bulletin label, so they are not fully independent.`,
    ].map((t) => `<li>${t}</li>`).join("");
  }

  function buildSlopeResults(D) {
    const box = $("slope-results");
    if (!D.slope) return;
    const v = D.slope.val_scores;
    box.innerHTML = `<p class="caps">Slope-scale model · validation winter</p>
      <div class="mini-stats">
        <div><b>${pct(v.recall_at_5pct, 0)}</b><span>of mapped avalanche cells fall in the 5% of terrain rated likeliest</span></div>
        <div><b>${pct(v.recall_at_10pct, 0)}</b><span>in the top 10%</span></div>
        <div><b>${pct(v.recall_at_1pct, 0)}</b><span>in the top 1%</span></div>
      </div>
      <p class="muted" style="font-size:13px;margin-top:8px">Average precision ${v.average_precision.toFixed(3)}. Scores from the validation split used to pick the checkpoint (epoch ${D.slope.epoch}); the map shows the test winters.</p>`;
  }

  // ---------------------------------------------------------------- start
  loadData().then((D) => {
    addPatterns();
    // the web build of the slope-scale files is 20 m, not 10 m: say so in the layer description
    if (D.slope) LAYERS.slope.desc = LAYERS.slope.desc.replace("10 m", `${D.slope.grid.cell_size} m`);
    const M = buildMaps(D);
    applyBase(M);
    applyStations(M);
    applyGrid(M);
    $("toggle-grid").addEventListener("click", () => { state.grid = !state.grid; applyGrid(M); });
    $("toggle-stations").addEventListener("click", () => { state.stations = !state.stations; applyStations(M); });
    // overlay opacity: scales the fill of every danger layer on both maps; outlines stay as they are
    $("opacity").addEventListener("input", (e) => {
      state.opacity = Number(e.target.value) / 100;
      $("opacity-value").textContent = e.target.value + "%";
      for (const side of SIDES) for (const layer of Object.values(M.layers[side])) layer.setStyle(layer.options.style);
      for (const side of SIDES) if (M.slope[side]) M.slope[side].setOpacity(state.opacity);
    });
    wireTour(M, D);
    // Avalanches on or off: the outlines, the highlighted one and the tour buttons all follow this one switch
    $("toggle-avalanches").addEventListener("click", () => {
      state.avalanches = !state.avalanches;
      applyAvalanches(M, D);
      if (!state.avalanches) { tour.at = -1; for (const side of SIDES) M.focus[side].clearLayers(); }
      updateTourControls();
    });
    wireLayerSelects(M);
    applyLayers(M);
    buildLegend();
    const popup = wireInfo(M, D);
    wireFullscreen(M, D, popup);
    wireDays(M, D, popup);
    wireJumps(M, D, popup);
    buildResults(D);
    buildSlopeResults(D);

    const fromHash = D.days.days.indexOf(decodeURIComponent(location.hash.slice(1)));
    const busiest = D.activity.counts.reduce((best, c, i, a) => ((c || 0) > (a[best] || 0) ? i : best), 0);
    setDay(M, D, popup, fromHash >= 0 ? fromHash : busiest);
  }).catch((err) => {
    console.error(err);
    $("map-left").innerHTML = `<p style="padding:24px;color:#C9D0D8">The map data could not be loaded (${err.message}). Serve this folder over HTTP, for example: python3 -m http.server</p>`;
  });
})();
