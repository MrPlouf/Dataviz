import * as d3 from "d3";
import { feature } from "topojson-client";
import "./style.css";


const state = {
  theme: document.documentElement.dataset.theme || "dark",

  metric: "co2_pc",
  mode: "value",
  year: 2023,
  brush: [2000, 2023],

  scene: "A",
  pinned: new Set(),
  hoveredIso3: null,

  focusIso3: null,
  selected: new Set(),

  compare: {
    x: "energy_pc",
    y: "co2_pc",
    size: "none",
    color: "temp_anom",
  },
};

let isProgrammaticBrush = false;

const metrics = {
  co2_pc: {
    label: "CO₂ emissions per capita",
    what: "Average CO₂ emissions per person in a country for a given year.",
    unit: "t CO₂ / person / year",
    fmt: d3.format(".2f"),
    source: "OWID-style country indicators",
  },
  energy_pc: {
    label: "Energy use per capita",
    what: "Average energy consumption per person (all energy sources).",
    unit: "kWh / person / year",
    fmt: d3.format(".0f"),
    source: "OWID-style energy indicators",
  },
  water_basic_pct: {
    label: "Basic drinking water access",
    what: "Share of population using at least basic drinking water services.",
    unit: "% of population",
    fmt: d3.format(".0f"),
    source: "OWID-style development indicators",
  },
  sanitation_pct: {
    label: "Improved sanitation access",
    what: "Share of population with access to improved sanitation facilities.",
    unit: "% of population",
    fmt: d3.format(".0f"),
    source: "OWID-style development indicators",
  },
  gdp_pc: {
    label: "GDP per capita (Maddison)",
    what: "Economic output per person (historical reconstruction).",
    unit: "$ per person",
    fmt: d3.format(".0f"),
    source: "Maddison Project (via dataset)",
  },
  temp_anom: {
    label: "Temperature anomaly",
    what: "Annual mean temperature anomaly for a country (mean of monthly anomalies).",
    unit: "°C anomaly",
    fmt: d3.format(".2f"),
    source: "Monthly temperature anomalies (country) dataset",
  },
};

const el = {
  metricSelect: document.querySelector("#metricSelect"),
  modeSelect: document.querySelector("#modeSelect"),
  yearSlider: document.querySelector("#yearSlider"),
  yearLabel: document.querySelector("#yearLabel"),
  themeBtn: document.querySelector("#themeBtn"),

  compareBtn: document.querySelector("#compareBtn"),
  compareOverlay: document.querySelector("#compareOverlay"),
  compareCloseBtn: document.querySelector("#compareCloseBtn"),
  xSelect: document.querySelector("#xSelect"),
  ySelect: document.querySelector("#ySelect"),
  sizeSelect: document.querySelector("#sizeSelect"),
  colorSelect: document.querySelector("#colorSelect"),
  scatter: document.querySelector("#scatter"),
  selectionList: document.querySelector("#selectionList"),
  compareTraj: document.querySelector("#compareTraj"),

  focusOverlay: document.querySelector("#focusOverlay"),
  focusCloseBtn: document.querySelector("#focusCloseBtn"),
  focusPinBtn: document.querySelector("#focusPinBtn"),
  focusCountry: document.querySelector("#focusCountry"),
  focusSub: document.querySelector("#focusSub"),
  focusExplain: document.querySelector("#focusExplain"),
  focusChart: document.querySelector("#focusChart"),
  focusStats: document.querySelector("#focusStats"),

  vizTitle: document.querySelector("#vizTitle"),
  vizMeta: document.querySelector("#vizMeta"),

  map: document.querySelector("#map"),
  timeline: document.querySelector("#timeline"),
  legendBar: document.querySelector("#legendBar"),
  hist: document.querySelector("#hist"),

  countryTitle: document.querySelector("#countryTitle"),
  countryValue: document.querySelector("#countryValue"),
  countryMeta: document.querySelector("#countryMeta"),
  pinnedList: document.querySelector("#pinnedList"),

  tooltip: document.querySelector("#tooltip"),

  stripes: document.querySelector("#globalStripes"),

  storySteps: Array.from(document.querySelectorAll(".storyStep")),
};

let rows = [];
let years = [];
let iso3ToSeries = new Map();
let iso3ToCountry = new Map();
let worldFeatures = [];

let mapApi = null;
let timelineApi = null;
let scatterApi = null;
let focusApi = null;
let stripesApi = null;

let globalTempMonthly = null;


function isFiniteNumber(x) {
  return x != null && Number.isFinite(+x);
}

function getMetricValue(row, metric) {
  const v = row?.[metric];
  return isFiniteNumber(v) ? +v : null;
}

function extentSafe(values) {
  const v = values.filter(isFiniteNumber);
  if (!v.length) return [0, 1];
  const e = d3.extent(v);
  if (e[0] === e[1]) return [e[0] - 1, e[1] + 1];
  return e;
}

function clampYear(y) {
  return Math.max(years[0], Math.min(y, years[years.length - 1]));
}

function meta(metricKey = state.metric) {
  return metrics[metricKey] || { label: metricKey, what: "", unit: "", fmt: d3.format(".2f"), source: "" };
}

function modeLabel() {
  if (state.mode === "value") return `Value in ${state.year}`;
  const [a, b] = state.brush;
  if (state.mode === "delta") return `Delta (${a} → ${b})`;
  return `Slope (${a} → ${b}) per year`;
}

function explainCurrentEncoding() {
  const m = meta(state.metric);
  if (state.mode === "value") {
    return `Map color shows <b>${m.label}</b> in <b>${state.year}</b>. ${m.what} <span class="wowSource">Unit: ${m.unit}.</span>`;
  }
  const [a, b] = state.brush;
  if (state.mode === "delta") {
    return `Map color shows the <b>change</b> in <b>${m.label}</b> between <b>${a}</b> and <b>${b}</b>. Positive = increase, negative = decrease. <span class="wowSource">Unit: ${m.unit}.</span>`;
  }
  return `Map color shows the <b>average yearly change</b> in <b>${m.label}</b> between <b>${a}</b> and <b>${b}</b>. Positive = rising trend, negative = falling trend. <span class="wowSource">Unit: ${m.unit}.</span>`;
}

function firstLastInRange(series, metric, a, b) {
  const s = series.filter(d => d.year >= a && d.year <= b);
  if (!s.length) return [null, null];

  let first = null;
  for (let i = 0; i < s.length; i++) {
    const v = getMetricValue(s[i], metric);
    if (v != null) { first = { year: s[i].year, v }; break; }
  }

  let last = null;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = getMetricValue(s[i], metric);
    if (v != null) { last = { year: s[i].year, v }; break; }
  }

  return [first, last];
}

function computeCountryValue(iso3, metricKey = state.metric) {
  const series = iso3ToSeries.get(iso3);
  if (!series) return null;

  if (state.mode === "value") {
    const row = series.find(d => d.year === state.year);
    return getMetricValue(row, metricKey);
  }

  const [a, b] = state.brush;
  const [first, last] = firstLastInRange(series, metricKey, a, b);
  if (!first || !last) return null;

  if (state.mode === "delta") return last.v - first.v;
  if (state.mode === "slope") {
    const dt = (last.year - first.year);
    return dt === 0 ? null : (last.v - first.v) / dt;
  }
  return null;
}

function valueAtYear(iso3, metricKey, year = state.year) {
  const series = iso3ToSeries.get(iso3);
  if (!series) return null;
  const row = series.find(d => d.year === year);
  return getMetricValue(row, metricKey);
}

function formatValue(v, metricKey = state.metric) {
  const m = meta(metricKey);
  return v == null ? "No data" : `${m.fmt(v)} ${m.unit}`;
}

function countryName(iso3) {
  return iso3ToCountry.get(iso3) || iso3;
}

function setScene(scene) {
  state.scene = scene;

  if (scene === "A") state.mode = "value";
  if (scene === "B" && state.mode === "value") state.mode = "slope";
  if (scene === "C") {
    if (state.mode === "value") state.mode = "slope";
  }

  el.modeSelect.value = state.mode;

  el.storySteps.forEach(btn => btn.classList.toggle("active", btn.dataset.scene === scene));

  renderAll();

  if (scene === "C") openCompare(true);
}

function updateStoryCopy() {
  const m = meta(state.metric);

  if (state.scene === "A") {
    el.vizTitle.textContent = `Scene A — Distribution`;
    el.vizMeta.innerHTML = `${explainCurrentEncoding()} <br/>Try: move the <b>Year</b> slider and spot outliers with the histogram.`;
    return;
  }

  if (state.scene === "B") {
    el.vizTitle.textContent = `Scene B — Change`;
    el.vizMeta.innerHTML = `${explainCurrentEncoding()} <br/>Try: brush different windows to reveal <b>phases</b>, then pin contrasts.`;
    return;
  }

  el.vizTitle.textContent = `Scene C — Compare Lab`;
  el.vizMeta.innerHTML =
    `Compare uses <b>values at year ${state.year}</b> (not slope), so axes are interpretable. Trajectories still show evolution. <span class="wowSource">Metric: ${m.label}.</span>`;
}

function openOverlay(node) { node.setAttribute("aria-hidden", "false"); }
function closeOverlay(node) { node.setAttribute("aria-hidden", "true"); }

function openFocus(iso3) {
  state.focusIso3 = iso3;
  openOverlay(el.focusOverlay);
  renderFocus();
}

function closeFocus() {
  state.focusIso3 = null;
  closeOverlay(el.focusOverlay);
}

function openCompare(force = false) {
  openOverlay(el.compareOverlay);
  if (force) {
    state.scene = "C";
    el.storySteps.forEach(btn => btn.classList.toggle("active", btn.dataset.scene === "C"));
  }
  renderCompare();
}
function closeCompare() { closeOverlay(el.compareOverlay); }

function showTooltip(html, x, y) {
  el.tooltip.innerHTML = html;
  el.tooltip.style.left = `${x + 12}px`;
  el.tooltip.style.top = `${y + 12}px`;
  el.tooltip.style.opacity = 1;
}
function hideTooltip() { el.tooltip.style.opacity = 0; }

function tooltipHtml(iso3) {
  const m = meta(state.metric);
  const name = countryName(iso3);
  const v = computeCountryValue(iso3, state.metric);

  let modeExplain = "";
  if (state.mode === "value") modeExplain = `Value for <b>${state.year}</b>`;
  else if (state.mode === "delta") modeExplain = `Change from <b>${state.brush[0]}</b> to <b>${state.brush[1]}</b>`;
  else modeExplain = `Avg yearly change from <b>${state.brush[0]}</b> to <b>${state.brush[1]}</b>`;

  return `
    <div style="font-weight:900;margin-bottom:6px">${name}</div>
    <div style="color:var(--muted);line-height:1.35">
      <div><b>${m.label}</b></div>
      <div>${m.what}</div>
      <div style="margin-top:6px">${modeExplain}</div>
      <div style="margin-top:6px"><b>Unit:</b> ${m.unit}</div>
    </div>
    <div style="font-size:18px;font-weight:900;margin-top:10px">
      ${formatValue(v, state.metric)}
    </div>
    <div style="margin-top:8px;color:var(--muted);font-size:11px">
      Click = Focus • Shift+Click = Pin
    </div>
  `;
}

function updateHoverPanel(iso3) {
  const m = meta(state.metric);
  const name = countryName(iso3);
  const v = computeCountryValue(iso3, state.metric);

  el.countryTitle.textContent = name;
  el.countryValue.textContent = formatValue(v, state.metric);
  el.countryMeta.innerHTML = `
    <div><b>${m.label}</b> • ${modeLabel()}</div>
    <div style="color:var(--muted); margin-top:4px">${m.what}</div>
    <div style="color:var(--muted); margin-top:4px"><b>Unit:</b> ${m.unit}</div>
  `;
}

function clearHoverPanel() {
  if (state.hoveredIso3) return;
  el.countryTitle.textContent = "Hover a country";
  el.countryValue.textContent = "";
  el.countryMeta.textContent = "";
}

function renderPinned() {
  const m = meta(state.metric);
  el.pinnedList.innerHTML = "";
  const pinned = Array.from(state.pinned);

  if (!pinned.length) {
    el.pinnedList.innerHTML = `<div class="hint">No pinned countries yet.</div>`;
    return;
  }

  for (const iso3 of pinned) {
    const name = countryName(iso3);
    const series = iso3ToSeries.get(iso3) || [];
    const current = computeCountryValue(iso3, state.metric);

    const item = document.createElement("div");
    item.className = "pinItem";

    const row = document.createElement("div");
    row.className = "pinRow";

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="pinName">${name}</div>
      <div class="pinSmall">${m.label} • ${modeLabel()}</div>
      <div class="pinBig">${formatValue(current, state.metric)}</div>
    `;

    const btn = document.createElement("button");
    btn.className = "pinBtn";
    btn.textContent = "Unpin";
    btn.addEventListener("click", () => {
      state.pinned.delete(iso3);
      renderAll();
    });

    row.appendChild(left);
    row.appendChild(btn);
    item.appendChild(row);

    const spark = document.createElement("div");
    spark.className = "spark";
    item.appendChild(spark);
    el.pinnedList.appendChild(item);

    renderSparkline(spark, series, state.metric);
  }
}

function renderSparkline(container, series, metricKey) {
  container.innerHTML = "";
  const width = container.clientWidth;
  const height = container.clientHeight || 44;

  const data = years.map(y => {
    const r = series.find(d => d.year === y);
    return { year: y, v: getMetricValue(r, metricKey) };
  });

  const vals = data.map(d => d.v).filter(isFiniteNumber);
  if (!vals.length) {
    const empty = document.createElement("div");
    empty.className = "sparkEmpty";
    empty.textContent = "No data for this metric";
    container.appendChild(empty);
    return;
  }

  const margin = { top: 4, right: 6, bottom: 4, left: 6 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  const svg = d3.select(container).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain(d3.extent(years)).range([0, w]);
  const y = d3.scaleLinear().domain(extentSafe(vals)).range([h, 0]);

  const line = d3.line()
    .defined(d => isFiniteNumber(d.v))
    .x(d => x(d.year))
    .y(d => y(d.v));

  g.append("path")
    .attr("fill", "none")
    .attr("stroke", "var(--accent)")
    .attr("stroke-width", 1.4)
    .attr("d", line(data));

  const [a, b] = state.brush;
  g.append("rect")
    .attr("x", x(a))
    .attr("y", 0)
    .attr("width", Math.max(0, x(b) - x(a)))
    .attr("height", h)
    .attr("fill", "rgba(106,164,255,0.14)");
}

function renderLegendAndHist(values, domain, color) {
  el.legendBar.innerHTML = "";
  const W = el.legendBar.clientWidth || 420;
  const barH = 14;

  const m = meta(state.metric);

  const svg = d3.select(el.legendBar).append("svg").attr("width", W).attr("height", 34);
  const defs = svg.append("defs");
  const grad = defs.append("linearGradient").attr("id", "grad").attr("x1", "0%").attr("x2", "100%");

  const stops = d3.range(0, 1.0001, 0.05);
  grad.selectAll("stop")
    .data(stops)
    .join("stop")
    .attr("offset", d => `${d * 100}%`)
    .attr("stop-color", d => color(domain[0] + d * (domain[1] - domain[0])));

  svg.append("rect")
    .attr("x", 0).attr("y", 8)
    .attr("width", W).attr("height", barH)
    .attr("rx", 6)
    .attr("fill", "url(#grad)")
    .attr("stroke", "var(--border)");

  svg.append("text").attr("x", 0).attr("y", 32).attr("fill", "var(--muted)").attr("font-size", 11)
    .text(`${m.fmt(domain[0])}`);

  svg.append("text").attr("x", W).attr("y", 32).attr("text-anchor", "end")
    .attr("fill", "var(--muted)").attr("font-size", 11)
    .text(`${m.fmt(domain[1])}`);

  el.hist.innerHTML = "";
  const HW = el.hist.clientWidth || 420;
  const HH = el.hist.clientHeight || 98;
  const margin = { top: 8, right: 8, bottom: 18, left: 30 };
  const w = HW - margin.left - margin.right;
  const h = HH - margin.top - margin.bottom;

  const hsvg = d3.select(el.hist).append("svg").attr("width", HW).attr("height", HH);
  const g = hsvg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain(domain).range([0, w]);
  const bins = d3.bin().domain(x.domain()).thresholds(18)(values);
  const y = d3.scaleLinear().domain([0, d3.max(bins, d => d.length) || 1]).range([h, 0]);

  g.selectAll("rect")
    .data(bins)
    .join("rect")
    .attr("x", d => x(d.x0))
    .attr("y", d => y(d.length))
    .attr("width", d => Math.max(1, x(d.x1) - x(d.x0) - 1))
    .attr("height", d => h - y(d.length))
    .attr("fill", d => color((d.x0 + d.x1) / 2))
    .attr("opacity", 0.9);

  g.append("g").attr("transform", `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(5).tickSizeOuter(0))
    .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
    .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

  g.append("g")
    .call(d3.axisLeft(y).ticks(3))
    .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
    .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));
}

function buildNameIndexForMatching() {
  const counts = new Map();
  for (const [iso3, name] of iso3ToCountry.entries()) {
    const key = String(name).toLowerCase().trim();
    counts.set(key, (counts.get(key) || []).concat(iso3));
  }
  const nameToIso = new Map();
  for (const [k, arr] of counts.entries()) nameToIso.set(k, arr[0]);

  const alias = new Map([
    ["united states of america", "united states"],
    ["russian federation", "russia"],
    ["czechia", "czech republic"],
    ["myanmar", "burma"],
    ["viet nam", "vietnam"],
    ["syrian arab republic", "syria"],
    ["iran (islamic republic of)", "iran"],
    ["bolivia (plurinational state of)", "bolivia"],
    ["venezuela (bolivarian republic of)", "venezuela"],
    ["democratic republic of the congo", "democratic republic of congo"],
    ["republic of the congo", "congo"],
    ["tanzania, united republic of", "tanzania"],
    ["korea, republic of", "south korea"],
    ["korea, democratic people's republic of", "north korea"],
  ]);

  return { nameToIso, alias };
}

function initMap() {
  const width = el.map.clientWidth;
  const height = el.map.clientHeight || 520;

  const svg = d3.select(el.map).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g");

  const projection = d3.geoNaturalEarth1().fitSize([width, height], { type: "Sphere" });
  const path = d3.geoPath(projection);

  const { nameToIso, alias } = buildNameIndexForMatching();

  function attachIso3(features) {
    let matched = 0;
    for (const f of features) {
      const nm = (f.properties?.name || "").toLowerCase().trim();
      const key = alias.get(nm) || nm;
      const iso = nameToIso.get(key);
      if (iso) matched++;
      f.properties = f.properties || {};
      f.properties.iso3 = iso || null;
    }
    console.log(`Map matching: ${matched}/${features.length} matched to iso3`);
    return features.filter(d => d.properties.iso3);
  }

  function update() {
    updateStoryCopy();

    const values = worldFeatures.map(f => computeCountryValue(f.properties.iso3, state.metric)).filter(isFiniteNumber);
    const domain = extentSafe(values);
    const color = d3.scaleSequential(d3.interpolateViridis).domain(domain);

    const selection = g.selectAll("path.country").data(worldFeatures, d => d.properties.iso3);

    selection.join(
      enter => enter.append("path")
        .attr("class", "country")
        .attr("d", path)
        .attr("stroke", "var(--border)")
        .attr("fill", "rgba(0,0,0,0)")
        .on("mousemove", (event, f) => {
          const iso3 = f.properties.iso3;
          state.hoveredIso3 = iso3;
          showTooltip(tooltipHtml(iso3), event.clientX, event.clientY);
          updateHoverPanel(iso3);

          if (scatterApi) scatterApi.setHover(iso3);
        })
        .on("mouseleave", () => {
          state.hoveredIso3 = null;
          hideTooltip();
          clearHoverPanel();
          if (scatterApi) scatterApi.setHover(null);
        })
        .on("click", (event, f) => {
          const iso3 = f.properties.iso3;

          if (event.shiftKey) {
            if (state.pinned.has(iso3)) state.pinned.delete(iso3);
            else state.pinned.add(iso3);
            renderAll();
            return;
          }

          openFocus(iso3);
        }),
      u => u,
      exit => exit.remove()
    )
    .attr("d", path)
    .attr("stroke", d => {
      const iso3 = d.properties.iso3;
      if (state.pinned.has(iso3)) return "var(--accent)";
      if (state.selected.has(iso3)) return "rgba(255,255,255,0.9)";
      return "var(--border)";
    })
    .attr("stroke-width", d => {
      const iso3 = d.properties.iso3;
      if (state.pinned.has(iso3)) return 1.9;
      if (state.selected.has(iso3)) return 1.4;
      return 0.8;
    })
    .attr("fill", d => {
      const v = computeCountryValue(d.properties.iso3, state.metric);
      return v == null ? "rgba(0,0,0,0)" : color(v);
    })
    .attr("opacity", d => {
      const iso3 = d.properties.iso3;
      if (state.scene === "C" && state.selected.size > 0) {
        return (state.selected.has(iso3) || state.pinned.has(iso3)) ? 1 : 0.35;
      }
      return 1;
    });

    renderLegendAndHist(values, domain, color);
  }

  async function loadWorld() {
    const world = await d3.json(new URL("world-atlas/countries-110m.json", import.meta.url));
    const countries = feature(world, world.objects.countries).features;
    worldFeatures = attachIso3(countries);
  }

  return { update, loadWorld };
}

function buildGlobalMedianSeries(metricKey) {
  const byYear = new Map(years.map(y => [y, []]));
  for (const [, series] of iso3ToSeries.entries()) {
    for (const r of series) {
      const v = getMetricValue(r, metricKey);
      if (v == null) continue;
      if (byYear.has(r.year)) byYear.get(r.year).push(v);
    }
  }
  return years.map(y => {
    const arr = byYear.get(y) || [];
    return { year: y, v: arr.length ? d3.median(arr) : null };
  });
}

function initTimeline() {
  const width = el.timeline.clientWidth;
  const height = el.timeline.clientHeight || 120;

  const margin = { top: 10, right: 10, bottom: 22, left: 36 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  const svg = d3.select(el.timeline).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain(d3.extent(years)).range([0, w]);
  const y = d3.scaleLinear().range([h, 0]);

  const xAxisG = g.append("g").attr("transform", `translate(0,${h})`);
  const yAxisG = g.append("g");

  const lineG = g.append("path")
    .attr("fill", "none")
    .attr("stroke", "var(--accent)")
    .attr("stroke-width", 1.6);

  const brushG = g.append("g").attr("class", "brush");

  const brush = d3.brushX()
    .extent([[0, 0], [w, h]])
    .on("brush end", (event) => {
      if (isProgrammaticBrush) return;
      if (!event.sourceEvent) return;
      if (!event.selection) return;

      const [x0, x1] = event.selection;
      const a = clampYear(Math.round(x.invert(x0)));
      const b = clampYear(Math.round(x.invert(x1)));
      state.brush = [Math.min(a, b), Math.max(a, b)];

      if (state.mode === "value") {
        state.mode = "slope";
        state.scene = "B";
        el.modeSelect.value = state.mode;
        el.storySteps.forEach(btn => btn.classList.toggle("active", btn.dataset.scene === state.scene));
      }

      renderAll();
    });

  brushG.call(brush);

  function setBrush(a, b) {
    isProgrammaticBrush = true;
    brushG.call(brush.move, [x(a), x(b)]);
    isProgrammaticBrush = false;
  }

  function update() {
    const series = buildGlobalMedianSeries(state.metric);
    const vals = series.map(d => d.v).filter(isFiniteNumber);
    y.domain(extentSafe(vals.length ? vals : [0, 1]));

    const line = d3.line()
      .defined(d => isFiniteNumber(d.v))
      .x(d => x(d.year))
      .y(d => y(d.v));

    lineG.attr("d", line(series));

    xAxisG.call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")));
    yAxisG.call(d3.axisLeft(y).ticks(4));

    setBrush(state.brush[0], state.brush[1]);
  }

  return { update };
}

function initFocusChart() {
  const node = el.focusChart;

  function render(iso3) {
    node.innerHTML = "";
    if (!iso3) return;

    const series = iso3ToSeries.get(iso3) || [];
    const m = meta(state.metric);

    const data = years.map(y => {
      const r = series.find(d => d.year === y);
      return { year: y, v: getMetricValue(r, state.metric) };
    });

    const vals = data.map(d => d.v).filter(isFiniteNumber);
    const width = node.clientWidth || 640;
    const height = node.clientHeight || 220;
    const margin = { top: 12, right: 12, bottom: 28, left: 46 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(node).append("svg").attr("width", width).attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain(d3.extent(years)).range([0, w]);
    const y = d3.scaleLinear().domain(extentSafe(vals.length ? vals : [0, 1])).range([h, 0]);

    const [a, b] = state.brush;
    g.append("rect")
      .attr("x", x(a))
      .attr("y", 0)
      .attr("width", Math.max(0, x(b) - x(a)))
      .attr("height", h)
      .attr("fill", "rgba(106,164,255,0.12)");

    const line = d3.line()
      .defined(d => isFiniteNumber(d.v))
      .x(d => x(d.year))
      .y(d => y(d.v));

    g.append("path")
      .attr("fill", "none")
      .attr("stroke", "var(--accent)")
      .attr("stroke-width", 2)
      .attr("d", line(data));

    g.append("g").attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")))
      .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
      .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

    g.append("g")
      .call(d3.axisLeft(y).ticks(4))
      .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
      .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

    const [first, last] = firstLastInRange(series, state.metric, state.brush[0], state.brush[1]);
    let msg = "";
    if (!first || !last) {
      msg = `No data in the brushed window.`;
    } else {
      const delta = last.v - first.v;
      const slope = (last.year - first.year) ? delta / (last.year - first.year) : null;
      msg =
        `<b>${m.label}</b><br/>
         First available: <b>${m.fmt(first.v)}</b> (${first.year})<br/>
         Last available: <b>${m.fmt(last.v)}</b> (${last.year})<br/>
         Δ: <b>${m.fmt(delta)}</b> ${m.unit}<br/>
         Slope: <b>${slope == null ? "—" : m.fmt(slope)}</b> ${m.unit} / year`;
    }
    el.focusStats.innerHTML = msg;
  }

  return { render };
}

function renderFocus() {
  const iso3 = state.focusIso3;
  if (!iso3) return;

  const name = countryName(iso3);
  const m = meta(state.metric);
  const v = computeCountryValue(iso3, state.metric);

  el.focusCountry.textContent = name;
  el.focusSub.textContent = `${m.label} • ${modeLabel()}`;
  el.focusExplain.innerHTML = `
    <b>${m.label}</b><br/>
    ${m.what}<br/>
    <span class="wowSource">Unit: ${m.unit}. Source: ${m.source}.</span>
    <div style="margin-top:10px;font-weight:900;font-size:18px">${formatValue(v, state.metric)}</div>
  `;

  const pinned = state.pinned.has(iso3);
  el.focusPinBtn.textContent = pinned ? "Unpin" : "Pin";

  focusApi.render(iso3);
}

function initStripes() {
  const node = el.stripes;

  function render() {
    if (!globalTempMonthly) return;
    node.innerHTML = "";

    const data = globalTempMonthly
      .filter(d => d.year >= years[0] && d.year <= years[years.length - 1])
      .map(d => ({ year: +d.year, month_idx: +d.month_idx, v: +d.temp_anom }))
      .filter(d => Number.isFinite(d.v) && Number.isFinite(d.month_idx));

    const width = node.clientWidth || 300;
    const height = node.clientHeight || 74;

    const svg = d3.select(node).append("svg").attr("width", width).attr("height", height);

    const domain = extentSafe(data.map(d => d.v));
    const color = d3.scaleSequential(d3.interpolateRdBu).domain([domain[1], domain[0]]);

    const cols = data.length;
    const cellW = width / cols;

    svg.selectAll("rect")
      .data(data)
      .join("rect")
      .attr("x", (_, i) => i * cellW)
      .attr("y", 0)
      .attr("width", Math.ceil(cellW) + 0.5)
      .attr("height", height)
      .attr("fill", d => color(d.v))
      .attr("opacity", 0.95);

    svg.append("text").attr("x", 6).attr("y", 14).attr("fill", "rgba(255,255,255,0.75)").attr("font-size", 10)
      .text(`${years[0]}`);
    svg.append("text").attr("x", width - 6).attr("y", 14).attr("text-anchor", "end")
      .attr("fill", "rgba(255,255,255,0.75)").attr("font-size", 10)
      .text(`${years[years.length - 1]}`);
  }

  return { render };
}

function initCompare() {
  const keys = Object.keys(metrics);
  const opts = keys.map(k => `<option value="${k}">${metrics[k].label}</option>`).join("");

  el.xSelect.innerHTML = opts;
  el.ySelect.innerHTML = opts;
  el.sizeSelect.innerHTML = `<option value="none">(none)</option>` + opts;
  el.colorSelect.innerHTML = `<option value="none">(none)</option>` + opts;

  el.xSelect.value = state.compare.x;
  el.ySelect.value = state.compare.y;
  el.sizeSelect.value = state.compare.size;
  el.colorSelect.value = state.compare.color;

  el.xSelect.addEventListener("change", () => { state.compare.x = el.xSelect.value; renderCompare(); });
  el.ySelect.addEventListener("change", () => { state.compare.y = el.ySelect.value; renderCompare(); });
  el.sizeSelect.addEventListener("change", () => { state.compare.size = el.sizeSelect.value; renderCompare(); });
  el.colorSelect.addEventListener("change", () => { state.compare.color = el.colorSelect.value; renderCompare(); });

  const scatterNode = el.scatter;
  let hoverIso3 = null;

  function setHover(iso3) {
    hoverIso3 = iso3;
    drawScatter();
  }

  function computePoint(iso3) {
    const xk = state.compare.x;
    const yk = state.compare.y;
    const sk = state.compare.size;
    const ck = state.compare.color;

    const xv = valueAtYear(iso3, xk, state.year);
    const yv = valueAtYear(iso3, yk, state.year);
    const sv = (sk && sk !== "none") ? valueAtYear(iso3, sk, state.year) : null;
    const cv = (ck && ck !== "none") ? valueAtYear(iso3, ck, state.year) : null;

    if (xv == null || yv == null) return null;
    return { iso3, name: countryName(iso3), x: xv, y: yv, s: sv, c: cv };
  }

  function drawScatter() {
    scatterNode.innerHTML = "";

    scatterNode.style.height = "340px";

    const width = scatterNode.clientWidth || 900;
    const height = Math.max(340, scatterNode.clientHeight || 0);

    const margin = { top: 14, right: 18, bottom: 52, left: 64 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(scatterNode).append("svg").attr("width", width).attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const pts = [];
    for (const iso3 of iso3ToSeries.keys()) {
      const p = computePoint(iso3);
      if (p) pts.push(p);
    }

    const xk = state.compare.x;
    const yk = state.compare.y;
    const sk = state.compare.size;
    const ck = state.compare.color;

    const xMeta = meta(xk);
    const yMeta = meta(yk);

    const x = d3.scaleLinear().domain(extentSafe(pts.map(d => d.x))).nice().range([0, w]);
    const y = d3.scaleLinear().domain(extentSafe(pts.map(d => d.y))).nice().range([h, 0]);

    const r = (sk && sk !== "none")
      ? d3.scaleSqrt().domain(extentSafe(pts.map(d => d.s).filter(isFiniteNumber))).range([2.8, 10])
      : (() => 4.5);

    const c = (ck && ck !== "none")
      ? d3.scaleSequential(d3.interpolateViridis).domain(extentSafe(pts.map(d => d.c).filter(isFiniteNumber)))
      : (() => "rgba(255,255,255,0.75)");

    g.append("g").attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(6))
      .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
      .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

    g.append("g")
      .call(d3.axisLeft(y).ticks(6))
      .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
      .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

    g.append("text")
      .attr("x", 0)
      .attr("y", h + 42)
      .attr("fill", "var(--muted)")
      .attr("font-size", 11)
      .text(`${xMeta.label} (${xMeta.unit}) — value in ${state.year}`);

    g.append("text")
      .attr("x", 0)
      .attr("y", -2)
      .attr("fill", "var(--muted)")
      .attr("font-size", 11)
      .text(`${yMeta.label} (${yMeta.unit}) — value in ${state.year}`);

    const brush = d3.brush()
      .extent([[0, 0], [w, h]])
      .on("brush end", (event) => {
        if (!event.selection) return;
        const [[x0, y0], [x1, y1]] = event.selection;
        const newly = new Set();

        for (const p of pts) {
          const px = x(p.x);
          const py = y(p.y);
          if (px >= x0 && px <= x1 && py >= y0 && py <= y1) newly.add(p.iso3);
        }
        state.selected = newly;
        renderAll();
      });

    g.append("g").attr("class", "scatterBrush").call(brush);

    g.selectAll("circle")
      .data(pts, d => d.iso3)
      .join("circle")
      .attr("cx", d => x(d.x))
      .attr("cy", d => y(d.y))
      .attr("r", d => r(d.s))
      .attr("fill", d => {
        if (ck && ck !== "none") return d.c == null ? "rgba(255,255,255,0.25)" : c(d.c);
        return "rgba(255,255,255,0.75)";
      })
      .attr("opacity", d => {
        if (state.selected.size > 0) return state.selected.has(d.iso3) ? 0.95 : 0.12;
        return 0.78;
      })
      .attr("stroke", d => {
        if (d.iso3 === hoverIso3) return "rgba(255,255,255,0.95)";
        if (state.pinned.has(d.iso3)) return "var(--accent)";
        if (state.selected.has(d.iso3)) return "rgba(255,255,255,0.85)";
        return "rgba(0,0,0,0)";
      })
      .attr("stroke-width", d => (d.iso3 === hoverIso3 || state.pinned.has(d.iso3) || state.selected.has(d.iso3)) ? 1.6 : 0)
      .on("mousemove", (event, d) => {
        setHover(d.iso3);

        const xv = meta(xk).fmt(d.x) + " " + meta(xk).unit;
        const yv = meta(yk).fmt(d.y) + " " + meta(yk).unit;

        showTooltip(
          `<div style="font-weight:900;margin-bottom:6px">${d.name}</div>
           <div style="color:var(--muted);font-size:12px;line-height:1.35">
             <div><b>X:</b> ${xv}</div>
             <div><b>Y:</b> ${yv}</div>
             <div style="margin-top:6px;color:var(--muted);font-size:11px">Values in <b>${state.year}</b></div>
           </div>
           <div style="margin-top:8px;color:var(--muted);font-size:11px">Click = Focus • Brush = Select</div>`,
          event.clientX, event.clientY
        );
      })
      .on("mouseleave", () => {
        setHover(null);
        hideTooltip();
      })
      .on("click", (_, d) => openFocus(d.iso3));
  }

  function renderSelectionList() {
    el.selectionList.innerHTML = "";
    const arr = Array.from(state.selected);

    if (!arr.length) {
      el.selectionList.innerHTML = `<div class="hint">No selection yet. Brush in the scatter plot.</div>`;
      return;
    }

    const scored = arr
      .map(iso3 => ({ iso3, name: countryName(iso3), v: computeCountryValue(iso3, state.metric) }))
      .sort((a, b) => d3.descending(a.v ?? -Infinity, b.v ?? -Infinity))
      .slice(0, 40);

    for (const d of scored) {
      const row = document.createElement("div");
      row.className = "selRow";
      row.innerHTML = `
        <div>
          <div class="selName">${d.name}</div>
          <div class="selMeta">${meta(state.metric).label}: <b>${formatValue(d.v, state.metric)}</b></div>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <button class="selBtn" data-action="focus">Focus</button>
          <button class="selBtn" data-action="pin">${state.pinned.has(d.iso3) ? "Unpin" : "Pin"}</button>
        </div>
      `;
      row.querySelector('[data-action="focus"]').addEventListener("click", () => openFocus(d.iso3));
      row.querySelector('[data-action="pin"]').addEventListener("click", () => {
        if (state.pinned.has(d.iso3)) state.pinned.delete(d.iso3);
        else state.pinned.add(d.iso3);
        renderAll();
      });
      el.selectionList.appendChild(row);
    }
  }

  function renderTrajectories() {
    el.compareTraj.innerHTML = "";

    const keys = new Set([...state.selected, ...state.pinned]);
    const list = Array.from(keys);
    if (!list.length) {
      el.compareTraj.innerHTML = `<div class="hint" style="padding:12px">Select in scatter or pin countries, then trajectories appear here.</div>`;
      return;
    }

    el.compareTraj.style.height = "240px";

    const width = el.compareTraj.clientWidth || 1000;
    const height = Math.max(240, el.compareTraj.clientHeight || 0);

    const margin = { top: 12, right: 18, bottom: 28, left: 56 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(el.compareTraj).append("svg").attr("width", width).attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const allSeries = [];
    for (const iso3 of list.slice(0, 24)) {
      const series = iso3ToSeries.get(iso3) || [];
      const data = years.map(y => {
        const r = series.find(d => d.year === y);
        return { year: y, v: getMetricValue(r, state.metric) };
      });
      allSeries.push({ iso3, name: countryName(iso3), data });
    }

    const allVals = allSeries.flatMap(s => s.data.map(d => d.v)).filter(isFiniteNumber);
    if (!allVals.length) {
      el.compareTraj.innerHTML = `<div class="hint" style="padding:12px">No trajectory data for this metric.</div>`;
      return;
    }

    const x = d3.scaleLinear().domain(d3.extent(years)).range([0, w]);
    const y = d3.scaleLinear().domain(extentSafe(allVals)).nice().range([h, 0]);

    const [a, b] = state.brush;
    g.append("rect")
      .attr("x", x(a))
      .attr("y", 0)
      .attr("width", Math.max(0, x(b) - x(a)))
      .attr("height", h)
      .attr("fill", "rgba(106,164,255,0.10)");

    g.append("g").attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")))
      .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
      .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

    g.append("g")
      .call(d3.axisLeft(y).ticks(5))
      .call(g => g.selectAll("text").attr("fill", "var(--muted)"))
      .call(g => g.selectAll("path,line").attr("stroke", "var(--border)"));

    const line = d3.line()
      .defined(d => isFiniteNumber(d.v))
      .x(d => x(d.year))
      .y(d => y(d.v));

    for (const s of allSeries) {
      g.append("path")
        .attr("d", line(s.data))
        .attr("fill", "none")
        .attr("stroke", state.pinned.has(s.iso3) ? "var(--accent)" : "rgba(255,255,255,0.55)")
        .attr("stroke-width", state.pinned.has(s.iso3) ? 2.2 : 1.3)
        .attr("opacity", 0.9);
    }
  }

  function renderAllCompare() {
    drawScatter();
    renderSelectionList();
    renderTrajectories();
  }

  return { renderAllCompare, setHover };
}

function renderCompare() {
  if (!scatterApi) return;
  scatterApi.renderAllCompare();
}

function initControls() {
  const available = new Set(rows.columns || Object.keys(rows[0] || {}));
  const opts = Object.entries(metrics)
    .filter(([k]) => available.has(k))
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");

  el.metricSelect.innerHTML = opts;

  if (!available.has(state.metric)) state.metric = el.metricSelect.value || "co2_pc";
  el.metricSelect.value = state.metric;

  el.modeSelect.value = state.mode;

  el.yearSlider.min = String(years[0]);
  el.yearSlider.max = String(years[years.length - 1]);
  el.yearSlider.value = String(state.year);
  el.yearLabel.textContent = String(state.year);

  el.metricSelect.addEventListener("change", () => {
    state.metric = el.metricSelect.value;
    renderAll();
  });

  el.modeSelect.addEventListener("change", () => {
    state.mode = el.modeSelect.value;
    state.scene = (state.mode === "value") ? "A" : "B";
    el.storySteps.forEach(btn => btn.classList.toggle("active", btn.dataset.scene === state.scene));
    renderAll();
  });

  el.yearSlider.addEventListener("input", () => {
    state.year = +el.yearSlider.value;
    el.yearLabel.textContent = String(state.year);
    renderAll();
  });

  el.themeBtn.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
  });

  el.storySteps.forEach(btn => {
    btn.addEventListener("click", () => setScene(btn.dataset.scene));
  });

  el.focusCloseBtn.addEventListener("click", closeFocus);
  el.focusOverlay.querySelectorAll("[data-close='focus']").forEach(n => n.addEventListener("click", closeFocus));

  el.compareBtn.addEventListener("click", () => openCompare(true));
  el.compareCloseBtn.addEventListener("click", closeCompare);
  el.compareOverlay.querySelectorAll("[data-close='compare']").forEach(n => n.addEventListener("click", closeCompare));

  el.focusPinBtn.addEventListener("click", () => {
    const iso3 = state.focusIso3;
    if (!iso3) return;
    if (state.pinned.has(iso3)) state.pinned.delete(iso3);
    else state.pinned.add(iso3);
    renderAll();
    renderFocus();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (el.focusOverlay.getAttribute("aria-hidden") === "false") closeFocus();
      if (el.compareOverlay.getAttribute("aria-hidden") === "false") closeCompare();
    }
  });
}

function updateControlsEnabled() {
  const brushMode = state.mode !== "value";
  el.yearSlider.disabled = brushMode;
  el.yearSlider.style.opacity = brushMode ? "0.5" : "1";
}

function renderAll() {
  if (!mapApi || !timelineApi) return;

  const compareOpen = el.compareOverlay.getAttribute("aria-hidden") === "false";
  if (compareOpen) state.scene = "C";

  updateControlsEnabled();
  el.yearLabel.textContent = String(state.year);
  el.yearSlider.value = String(state.year);
  el.modeSelect.value = state.mode;

  timelineApi.update();
  mapApi.update();

  renderPinned();
  if (state.hoveredIso3) updateHoverPanel(state.hoveredIso3);

  if (state.focusIso3) renderFocus();
  if (compareOpen) renderCompare();

  updateStoryCopy();
}

async function main() {
  rows = await d3.csv("/data/core_merged.csv", d3.autoType);

  years = Array.from(new Set(rows.map(d => d.year)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!years.length) throw new Error("No years found in core_merged.csv");

  const minY = Math.max(2000, years[0]);
  const maxY = Math.min(2023, years[years.length - 1]);
  years = years.filter(y => y >= minY && y <= maxY);

  state.year = maxY;
  state.brush = [minY, maxY];

  iso3ToSeries = d3.group(rows, d => d.iso3);

  for (const [iso3, arr] of iso3ToSeries.entries()) {
    arr.sort((a, b) => a.year - b.year);
    const counts = d3.rollup(arr, v => v.length, d => d.country);
    let best = null, bestN = -1;
    for (const [k, n] of counts.entries()) {
      if (n > bestN) { bestN = n; best = k; }
    }
    iso3ToCountry.set(iso3, best || iso3);
  }

  try {
    globalTempMonthly = await d3.csv("/data/global_temp_monthly.csv", d3.autoType);
  } catch (e) {
    console.warn("No global_temp_monthly.csv found, stripes disabled.", e);
    globalTempMonthly = null;
  }

  initControls();

  mapApi = initMap();
  timelineApi = initTimeline();
  focusApi = initFocusChart();
  scatterApi = initCompare();
  stripesApi = initStripes();

  await mapApi.loadWorld();

  if (globalTempMonthly) stripesApi.render();

  setScene("A");
  renderAll();
}

main().catch(err => {
  console.error(err);
  alert(String(err));
});
