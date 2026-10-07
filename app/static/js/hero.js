// The opening chart: the example portfolio's growth above a baseline and its fall from peak hanging below
// it, one hairline per trading day. It replays the period once, then lets visitors read any day.

import { el } from "./charts.js";
import { dollars, longDate, percent } from "./format.js";
import { deepestFall } from "./series.js";

const REPLAY_MS = 2600;
const BASE = 600; // baseline height inside the 1000-unit viewBox: growth above, drawdown below
const TOP = 30;
const DEPTH = 360;

export function renderHero({ host, readout, result }) {
  const values = result.portfolio_value.values;
  const drawdown = result.drawdown.values;
  const dates = result.portfolio_value.dates;
  const n = values.length;
  const last = n - 1;
  const fall = deepestFall(drawdown);
  const vMax = Math.max(...values.filter((v) => v != null));
  const ddMin = fall ? fall.depth : -0.01;
  const X = (i) => (i / last) * 1000;
  const YV = (v) => BASE - ((v - Math.min(1, ...values)) / (vMax - Math.min(1, ...values))) * (BASE - TOP);
  const YD = (d) => BASE + (d / ddMin) * DEPTH;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const svg = el("svg:svg", { viewBox: "0 0 1000 1000", preserveAspectRatio: "none", "aria-hidden": "true" });
  const revealRect = el("svg:rect", { x: 0, y: 0, width: still ? 1000 : 0, height: 1000 });
  const sweep = el("svg:linearGradient", { id: "sweep", gradientUnits: "userSpaceOnUse", x1: -180, x2: 0, y1: 0, y2: 0 }, [
    el("svg:stop", { offset: 0, "stop-color": "#F2F3F5", "stop-opacity": 0 }),
    el("svg:stop", { offset: 0.7, "stop-color": "#F2F3F5", "stop-opacity": 0.55 }),
    el("svg:stop", { offset: 1, "stop-color": "#F2F3F5", "stop-opacity": 0 }),
  ]);
  svg.append(
    el("svg:defs", {}, [
      el("svg:clipPath", { id: "reveal" }, [revealRect]),
      el("svg:filter", { id: "glow", x: "-5%", y: "-50%", width: "110%", height: "200%" }, [el("svg:feGaussianBlur", { stdDeviation: 5 })]),
      el("svg:linearGradient", { id: "fade-up", x1: 0, x2: 0, y1: 0, y2: 1 }, [
        el("svg:stop", { offset: 0, "stop-color": "#F2F3F5", "stop-opacity": 0 }),
        el("svg:stop", { offset: 1, "stop-color": "#F2F3F5", "stop-opacity": 0.16 }),
      ]),
      sweep,
    ])
  );

  const layers = el("svg:g", { "clip-path": "url(#reveal)" });
  const ambient = el("svg:g", { class: "hero-ambient" });
  const lineD = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${YV(v).toFixed(1)}`).join("");
  let hairlines = {};
  function drawHairlines() {
    // Thin screens get every other day, keeping the lowest drawdown of each pair so the low is never lost.
    const step = host.clientWidth < 600 ? 2 : 1;
    let up = "";
    let down = "";
    let risk = "";
    for (let i = 0; i < n; i += step) {
      let j = i;
      for (let k = i; k < Math.min(i + step, n); k += 1) if (drawdown[k] < drawdown[j]) j = k;
      if (fall && fall.low >= i && fall.low < i + step) j = fall.low;
      const x = X(j).toFixed(1);
      up += `M${x} ${BASE}V${YV(values[j]).toFixed(1)}`;
      if (drawdown[j] < -0.001) {
        const seg = `M${x} ${BASE}V${YD(drawdown[j]).toFixed(1)}`;
        const inFall = fall && j >= fall.peak && j <= (fall.recovered ?? last);
        if (inFall) risk += seg;
        else down += seg;
      }
    }
    hairlines.up.setAttribute("d", up);
    hairlines.down.setAttribute("d", down);
    hairlines.risk.setAttribute("d", risk);
    hairlines.sweepUp.setAttribute("d", up);
    hairlines.sweepDown.setAttribute("d", down);
  }
  hairlines = {
    up: el("svg:path", { class: "h-up" }),
    down: el("svg:path", { class: "h-down" }),
    risk: el("svg:path", { class: "h-risk" }),
    sweepUp: el("svg:path", { class: "h-sweep", stroke: "url(#sweep)" }),
    sweepDown: el("svg:path", { class: "h-sweep", stroke: "url(#sweep)" }),
  };
  layers.append(
    hairlines.up,
    hairlines.down,
    hairlines.risk,
    el("svg:path", { d: lineD, class: "h-glow", filter: "url(#glow)" }),
    el("svg:path", { d: lineD, class: "h-line" })
  );
  const pulseWide = el("svg:path", { d: lineD, class: "h-pulse wide", pathLength: 1, filter: "url(#glow)" });
  const pulse = el("svg:path", { d: lineD, class: "h-pulse", pathLength: 1 });
  ambient.append(hairlines.sweepUp, hairlines.sweepDown, pulseWide, pulse);
  svg.append(layers, ambient, el("svg:line", { x1: 0, x2: 1000, y1: BASE, y2: BASE, class: "h-base" }));
  const cursor = el("svg:line", { x1: 0, x2: 0, y1: 0, y2: 1000, class: "h-cursor", visibility: "hidden" });
  svg.append(cursor);
  drawHairlines();

  const years = [];
  dates.forEach((iso, i) => {
    if (i === 0 || iso.slice(0, 4) !== dates[i - 1].slice(0, 4)) years.push({ i, label: iso.slice(0, 4) });
  });
  const pos = (i, v) => `left:${X(i) / 10}%;top:${v / 10}%`;
  const overlay = [
    ...years.map((y) => el("span", { class: "h-year num", style: `left:calc(${X(y.i) / 10}% + 6px);top:${BASE / 10}%`, text: y.label })),
    el("i", { class: "h-dot", style: pos(last, YV(values[last])), hidden: !still }),
    el("i", { class: "h-ring", style: `${pos(last, YV(values[last]))};--delay:1.3s` }),
  ];
  const cursorDot = el("i", { class: "h-cursor-dot", hidden: true });
  overlay.push(cursorDot);
  if (fall) {
    const at = pos(fall.low, YD(fall.depth));
    const back = fall.recovered === null
      ? `Still below its ${longDate(dates[fall.peak])} peak on ${longDate(dates[last])}.`
      : `Back above its ${longDate(dates[fall.peak])} peak on ${longDate(dates[fall.recovered])}.`;
    overlay.push(
      el("i", { class: "h-low", style: at, hidden: !still }),
      el("i", { class: "h-ring risk", style: `${at};--delay:0s` }),
      el("div", { class: "h-note", style: at, hidden: !still }, [
        el("strong", { class: "display num", text: percent(fall.depth) }),
        el("span", { text: `${longDate(dates[fall.low])}, the deepest fall.` }),
        el("span", { class: "h-note-more", text: back }),
      ])
    );
  }
  const field = el(
    "div",
    {
      class: "h-field",
      tabindex: 0,
      role: "img",
      "aria-label": `Example portfolio: growth of $1 from ${longDate(dates[0])} to ${longDate(dates[last])}, ending at ${dollars(values[last])}. Below the line, the fall from its running peak.${fall ? ` The deepest was ${percent(Math.abs(fall.depth))} on ${longDate(dates[fall.low])}.` : ""} Use the arrow keys to read a day.`,
    },
    [svg, ...overlay]
  );
  host.replaceChildren(field);

  // Readout: the replay drives it first, then the pointer or keys do.
  let picked = null;
  let done = still;
  function read(i) {
    readout.date.textContent = longDate(dates[i]);
    readout.value.textContent = dollars(values[i]);
    const d = drawdown[i];
    readout.fall.textContent = d > -0.0005 ? "At its high" : `${percent(d)} from its peak`;
    readout.fall.classList.toggle("risk", Boolean(fall && i >= fall.peak && i <= (fall.recovered ?? last) && d < -0.0005));
  }
  function choose(i) {
    if (!done) return;
    picked = i;
    if (i === null) {
      cursor.setAttribute("visibility", "hidden");
      cursorDot.hidden = true;
      read(last);
      readout.hint.textContent = "Move along the chart, or focus it and use the arrow keys.";
      return;
    }
    cursor.setAttribute("x1", X(i));
    cursor.setAttribute("x2", X(i));
    cursor.setAttribute("visibility", "visible");
    cursorDot.hidden = false;
    cursorDot.style.left = `${X(i) / 10}%`;
    cursorDot.style.top = `${YV(values[i]) / 10}%`;
    read(i);
    readout.hint.textContent = `Day ${i + 1} of ${n}.`;
  }
  const fromPointer = (event) => {
    const box = field.getBoundingClientRect();
    choose(Math.max(0, Math.min(last, Math.round(((event.clientX - box.left) / box.width) * last))));
  };
  field.addEventListener("pointermove", fromPointer);
  field.addEventListener("pointerdown", fromPointer);
  field.addEventListener("pointerleave", (event) => event.pointerType === "mouse" && choose(null));
  field.addEventListener("blur", () => choose(null));
  field.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 21 : 1;
    const current = picked ?? last;
    const next = { ArrowLeft: current - step, ArrowRight: current + step, Home: 0, End: last, Escape: null }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(next === null ? null : Math.max(0, Math.min(last, next)));
  });

  function finish() {
    done = true;
    revealRect.setAttribute("width", 1000);
    field.querySelectorAll(".h-dot, .h-low, .h-note").forEach((node) => (node.hidden = false));
    readout.hint.textContent = "Move along the chart, or focus it and use the arrow keys.";
    read(last);
    if (!still) startAmbient();
  }

  // A band of light crosses the hairlines while a highlight runs along the line, every 7 seconds.
  function startAmbient() {
    const loop = (target, attributeName, values) => {
      const node = el("svg:animate", { attributeName, values, dur: "7s", begin: "indefinite", repeatCount: "indefinite" });
      target.append(node);
      return node;
    };
    const animations = [
      loop(sweep, "x1", "-180;1000"),
      loop(sweep, "x2", "0;1180"),
      loop(pulseWide, "stroke-dashoffset", "0.05;-1"),
      loop(pulse, "stroke-dashoffset", "0.025;-1"),
    ];
    animations.forEach((node) => node.beginElement?.());
    field.classList.add("alive");
  }

  if (still) {
    finish();
  } else {
    readout.hint.textContent = `Replaying ${n} trading days.`;
    let t0 = null;
    const frame = (t) => {
      if (t0 === null) t0 = t;
      const p = Math.min(1, (t - t0) / REPLAY_MS);
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      const i = Math.round(eased * last);
      revealRect.setAttribute("width", X(i) + 2);
      read(i);
      if (fall && i >= fall.low) field.querySelectorAll(".h-low, .h-note").forEach((node) => (node.hidden = false));
      if (p < 1) requestAnimationFrame(frame);
      else finish();
    };
    requestAnimationFrame(frame);
  }

  // The light sweep and travelling highlight only run while the opening is on screen.
  if (!still && "IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      field.classList.toggle("paused", !entry.isIntersecting);
      if (entry.isIntersecting) svg.unpauseAnimations?.();
      else svg.pauseAnimations?.();
    }).observe(field);
  }
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawHairlines, 150);
  }).observe(host);
}
