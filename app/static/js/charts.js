// Small SVG charts. Each chart draws into a 1000 x 1000 viewBox stretched to its box, with
// non-scaling strokes, and puts text in HTML so labels never stretch.

import { histogram, niceTicks } from "./series.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, children = []) {
  const node = tag.startsWith("svg:") ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.setAttribute("class", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

export function linePath(values, y, { from = 0, to = values.length - 1 } = {}) {
  const span = Math.max(1, to - from);
  let d = "";
  let pen = false;
  for (let i = from; i <= to; i += 1) {
    const v = values[i];
    if (v == null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${(((i - from) / span) * 1000).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

// Year labels for long windows, month labels for short ones.
function timeTicks(dates) {
  const n = dates.length;
  const long = n > 300;
  const ticks = [];
  let previous = "";
  dates.forEach((iso, i) => {
    const key = long ? iso.slice(0, 4) : iso.slice(0, 7);
    if (key !== previous) {
      ticks.push({ i, iso });
      previous = key;
    }
  });
  const every = Math.ceil(ticks.length / (long ? 8 : 6));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return ticks
    .filter((_, k) => k % every === 0)
    .map(({ i, iso }) => ({
      x: (i / Math.max(1, n - 1)) * 100,
      label: long ? iso.slice(0, 4) : `${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`,
    }))
    .filter((t) => t.x < 94);
}

// A time-series chart with a crosshair that follows the pointer or the arrow keys.
// series: [{ values, className, area }], scale: { lo, hi, ticks, format }
export function timeChart(host, { dates, series, scale, label, onHover }) {
  const n = dates.length;
  const y = (v) => 1000 - ((v - scale.lo) / (scale.hi - scale.lo)) * 1000;
  const svg = el("svg:svg", { viewBox: "0 0 1000 1000", preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const t of scale.ticks) {
    svg.append(el("svg:line", { x1: 0, x2: 1000, y1: y(t), y2: y(t), class: t === 0 && scale.zeroLine ? "axis" : "grid" }));
  }
  for (const s of series) {
    const d = linePath(s.values, y);
    if (s.area) svg.append(el("svg:path", { d: `${d}L1000 ${y(0)}L0 ${y(0)}Z`, class: `${s.className} area` }));
    svg.append(el("svg:path", { d, class: s.className, "data-key": s.key || null }));
  }
  const cursor = el("svg:line", { x1: 0, x2: 0, y1: 0, y2: 1000, class: "cursor", visibility: "hidden" });
  svg.append(cursor);

  const yLabels = scale.ticks.map((t) =>
    el("span", { class: "y-label num", style: `top:${(y(t) / 10).toFixed(2)}%`, text: scale.format(t) })
  );
  const xLabels = timeTicks(dates).map((t) => el("span", { class: "x-label num", style: `left:${t.x}%`, text: t.label }));
  const dot = el("i", { class: "chart-dot", hidden: true });
  const plot = el("div", { class: "plot", tabindex: 0, role: "img", "aria-label": label }, [svg, dot, ...yLabels]);
  host.replaceChildren(el("div", { class: "time-chart" }, [plot, el("div", { class: "x-axis" }, xLabels)]));

  let index = null;
  const primary = series[series.length - 1].values;
  function show(i) {
    index = i;
    if (i === null) {
      cursor.setAttribute("visibility", "hidden");
      dot.hidden = true;
    } else {
      const x = (i / Math.max(1, n - 1)) * 1000;
      cursor.setAttribute("x1", x);
      cursor.setAttribute("x2", x);
      cursor.setAttribute("visibility", "visible");
      if (primary[i] != null) {
        dot.hidden = false;
        dot.style.left = `${x / 10}%`;
        dot.style.top = `${y(primary[i]) / 10}%`;
      }
    }
    onHover?.(i);
  }
  const pick = (event) => {
    const box = plot.getBoundingClientRect();
    show(Math.max(0, Math.min(n - 1, Math.round(((event.clientX - box.left) / box.width) * (n - 1)))));
  };
  plot.addEventListener("pointermove", pick);
  plot.addEventListener("pointerdown", pick);
  plot.addEventListener("pointerleave", (event) => event.pointerType === "mouse" && show(null));
  plot.addEventListener("blur", () => show(null));
  plot.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 21 : 1;
    const current = index ?? n - 1;
    const next = { ArrowLeft: current - step, ArrowRight: current + step, Home: 0, End: n - 1, Escape: null }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(next === null ? null : Math.max(0, Math.min(n - 1, next)));
  });
  return { svg, show };
}

export function returnsHistogram(host, returns, { sd, format }) {
  const { bins } = histogram(returns);
  const top = Math.max(...bins.map((b) => b.count));
  const lo = bins[0].lo;
  const hi = bins[bins.length - 1].hi;
  const x = (v) => ((v - lo) / (hi - lo)) * 1000;
  const svg = el("svg:svg", { viewBox: "0 0 1000 1000", preserveAspectRatio: "none", "aria-hidden": "true" });
  bins.forEach((b) => {
    if (!b.count) return;
    const h = (b.count / top) * 1000;
    const tail = b.hi <= -sd || b.lo >= sd;
    svg.append(el("svg:rect", { x: x(b.lo) + 1.5, width: Math.max(1, x(b.hi) - x(b.lo) - 3), y: 1000 - h, height: h, class: tail ? "bar tail" : "bar" }));
  });
  for (const v of [-sd, sd]) svg.append(el("svg:line", { x1: x(v), x2: x(v), y1: 0, y2: 1000, class: "sd-line" }));
  svg.append(el("svg:line", { x1: x(0), x2: x(0), y1: 0, y2: 1000, class: "zero-line" }));
  const { ticks } = niceTicks(lo, hi, 6);
  const labels = ticks
    .filter((t) => t >= lo && t <= hi)
    .map((t) => el("span", { class: "x-label num", style: `left:${(x(t) / 10).toFixed(2)}%`, text: format(t) }));
  host.replaceChildren(
    el("div", { class: "time-chart" }, [
      el("div", { class: "plot hist" }, [svg, el("span", { class: "sd-tag", style: `left:${x(sd) / 10}%`, text: "+1 sd" }), el("span", { class: "sd-tag", style: `left:${x(-sd) / 10}%`, text: "−1 sd" })]),
      el("div", { class: "x-axis" }, labels),
    ])
  );
}
