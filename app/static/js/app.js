import { api, watchService } from "./api.js";
import { el, returnsHistogram, timeChart } from "./charts.js";
import { dollars, holdingsSummary, longDate, percent, percentInput, ratio, timeStamp, toDecimal } from "./format.js";
import { renderHero } from "./hero.js";
import { deletePortfolio, openStore, readSaved, savePortfolio } from "./saved.js";
import { dailyReturns, dateRanges, deepestFall, extent, niceTicks, rebase, sampleStdev } from "./series.js";

const MAX_HOLDINGS = 20;
const $ = (selector) => document.querySelector(selector);
const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  example: null, // { inputs, source, analysis } from static/example-analysis.json
  shown: null, // what the results area shows: { kind: "example" | "live", analysis, inputs, version, pricesAt, computedAt }
  service: "checking",
  running: false,
  inputsVersion: 0, // bumped on every input change, so stale results and late responses can be detected
  range: "All",
  highlight: null,
};

// ---------- Holdings form ----------

const holdingsEl = $("#holdings");
let rowCount = 0;

function addHoldingRow(symbol = "", weight = "") {
  if (holdingsEl.children.length >= MAX_HOLDINGS) return;
  const row = $("#holding-row").content.firstElementChild.cloneNode(true);
  rowCount += 1;
  const symbolInput = row.querySelector(".symbol");
  const weightInput = row.querySelector(".weight");
  const remove = row.querySelector(".remove");
  symbolInput.value = symbol;
  weightInput.value = weight;
  symbolInput.setAttribute("aria-label", `Symbol, holding ${rowCount}`);
  weightInput.setAttribute("aria-label", `Initial weight in percent, holding ${rowCount}`);
  const label = () => remove.setAttribute("aria-label", `Remove ${symbolInput.value.trim().toUpperCase() || "this holding"}`);
  label();
  symbolInput.addEventListener("input", label);
  remove.addEventListener("click", () => {
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    if (!holdingsEl.children.length) addHoldingRow();
    (next || holdingsEl.firstElementChild).querySelector(".symbol").focus();
    inputsChanged();
  });
  holdingsEl.append(row);
  updateHoldingControls();
}

function updateHoldingControls() {
  const rows = [...holdingsEl.children];
  const total = rows.reduce((sum, row) => sum + (Number(row.querySelector(".weight").value) || 0), 0);
  const ok = Math.abs(total - 100) < 0.0001;
  const totalEl = $("#weight-total");
  totalEl.textContent = ok ? "Weights total 100%" : `Weights total ${Number(total.toFixed(2))}%. They must add up to 100%.`;
  totalEl.classList.toggle("off", !ok);
  rows.forEach((row) => (row.querySelector(".remove").disabled = rows.length === 1));
  $("#add-holding").disabled = rows.length >= MAX_HOLDINGS;
  $("#add-holding").title = rows.length >= MAX_HOLDINGS ? `A portfolio can hold at most ${MAX_HOLDINGS} symbols.` : "";
}

function fillForm(inputs) {
  holdingsEl.replaceChildren();
  rowCount = 0;
  inputs.holdings.forEach((h) => addHoldingRow(h.symbol, percentInput(h.weight)));
  $("#start-date").value = inputs.start_date;
  $("#end-date").value = inputs.end_date;
  $("#risk-free-rate").value = percentInput(inputs.risk_free_rate);
  clearErrors();
}

function readForm() {
  return {
    holdings: [...holdingsEl.children].map((row) => ({
      symbol: row.querySelector(".symbol").value,
      weight: toDecimal(row.querySelector(".weight").value),
    })),
    start_date: $("#start-date").value || null,
    end_date: $("#end-date").value || null,
    risk_free_rate: toDecimal($("#risk-free-rate").value),
  };
}

function inputsChanged() {
  state.inputsVersion += 1;
  updateHoldingControls();
  updateStaleNote();
}

// ---------- Errors ----------

const SYMBOL_ERRORS = {
  NO_DATA: "No usable prices for this range.",
  MISSING_DATA: "Missing prices on days the other holdings traded.",
  PROVIDER_ERROR: "The provider returned invalid prices.",
};

function clearErrors() {
  document.querySelectorAll(".field-error").forEach((node) => (node.textContent = ""));
  document.querySelectorAll("input.invalid").forEach((node) => {
    node.classList.remove("invalid");
    node.removeAttribute("aria-invalid");
  });
  $("#request-error").hidden = true;
  $("#request-error").replaceChildren();
}

function appendText(node, message) {
  node.textContent = node.textContent ? `${node.textContent} ${message}` : message;
}

function markInvalid(input) {
  input.classList.add("invalid");
  input.setAttribute("aria-invalid", "true");
}

function setFieldError(field, message) {
  const holding = field.match(/^holdings\.(\d+)(?:\.(symbol|weight))?$/);
  if (holding) {
    const row = holdingsEl.children[Number(holding[1])];
    if (!row) return false;
    if (holding[2]) markInvalid(row.querySelector(`.${holding[2]}`));
    appendText(row.querySelector(".row-error"), message);
    return true;
  }
  const target = document.querySelector(`[data-error-for="${field}"]`);
  if (!target) return false;
  appendText(target, message);
  const input = target.closest(".field")?.querySelector("input");
  if (input) markInvalid(input);
  return true;
}

function showRequestError(error) {
  const unplaced = [];
  const details = error.details || {};
  if (error.code === "VALIDATION_ERROR") {
    for (const item of details.errors || []) if (!setFieldError(item.field, item.message)) unplaced.push(`${item.field}: ${item.message}`);
  }
  if (details.symbols && SYMBOL_ERRORS[error.code]) {
    for (const row of holdingsEl.children) {
      const input = row.querySelector(".symbol");
      if (details.symbols.includes(input.value.trim().toUpperCase())) {
        markInvalid(input);
        appendText(row.querySelector(".row-error"), SYMBOL_ERRORS[error.code]);
      }
    }
  }
  const extra = [...unplaced];
  if (details.dates?.length) extra.push(`Affected dates include ${details.dates.map(longDate).join(", ")}.`);
  if (error.code === "INSUFFICIENT_DATA" && details.observations !== undefined) extra.push(`Available daily returns: ${details.observations}.`);
  const kept = state.shown?.kind === "live" ? "The previous live result is still shown below." : "The example is still shown below.";
  const box = $("#request-error");
  box.replaceChildren(
    el("strong", { text: error.code === "VALIDATION_ERROR" ? "Please correct the highlighted fields." : error.message }),
    el("span", { text: ` Nothing was estimated. ${kept}` })
  );
  if (extra.length) box.append(el("ul", {}, extra.map((text) => el("li", { text }))));
  box.hidden = false;
  const firstInvalid = document.querySelector("input.invalid");
  if (firstInvalid) firstInvalid.focus();
  else box.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "nearest" });
}

// ---------- Live service ----------

const SERVICE_TEXT = {
  checking: ["Checking the live analysis service", "Checking", "Checking whether the analysis service is awake."],
  waking: ["Live analysis is starting up", "Starting up", "Waking the analysis service. This usually takes under a minute. Your edits are kept."],
  ready: ["Live analysis ready", "Ready", "Ready. A live result replaces the example below and is labelled with its time."],
  unavailable: ["Live analysis unavailable", "Unavailable", "The analysis service did not respond. The example still works; you can try again."],
};

function setService(next) {
  state.service = next;
  const [long, short, note] = SERVICE_TEXT[next];
  $("#service-long").textContent = long;
  $("#service-short").textContent = short;
  document.querySelector(".service").dataset.state = next;
  if (!state.running) $("#run-note").textContent = note;
  $("#run-wake").hidden = next !== "waking" && next !== "checking";
  $("#retry-service").hidden = next !== "unavailable";
  updateRunButton();
}

function updateRunButton() {
  const button = $("#run-button");
  button.disabled = state.service !== "ready" || state.running;
  if (!state.running) button.textContent = "Run live analysis";
}

// ---------- Running an analysis ----------

async function runLive(event) {
  event.preventDefault();
  if (state.service !== "ready" || state.running) return;
  clearErrors();
  const inputs = readForm();
  const version = state.inputsVersion;
  state.running = true;
  updateRunButton();
  const count = inputs.holdings.length;
  $("#run-button").textContent = `Fetching prices for ${count} holding${count === 1 ? "" : "s"}`;
  $("#run-note").textContent = "Fetching prices from Yahoo Finance and calculating. The current results stay on screen until this finishes.";
  $("#results").setAttribute("aria-busy", "true");
  $("#results").classList.add("loading");
  try {
    const analysis = await api("/api/v1/analyze", { method: "POST", body: inputs });
    if (version !== state.inputsVersion) {
      $("#run-note").textContent = "The inputs changed while that analysis was running, so its result was discarded. Run it again.";
      return;
    }
    state.shown = {
      kind: "live",
      analysis,
      inputs: { ...inputs, holdings: inputs.holdings.map((h) => ({ symbol: h.symbol.trim().toUpperCase(), weight: h.weight })) },
      version,
      pricesAt: analysis.prices_fetched_at,
      computedAt: new Date(),
    };
    state.range = "All";
    state.highlight = null;
    renderResults();
    $("#run-note").textContent = "Live result ready below.";
    $("#results-title").scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "start" });
  } catch (error) {
    if (version !== state.inputsVersion) return;
    showRequestError(error);
    $("#run-note").textContent = SERVICE_TEXT[state.service][2];
  } finally {
    state.running = false;
    $("#results").removeAttribute("aria-busy");
    $("#results").classList.remove("loading");
    updateRunButton();
  }
}

function showExample() {
  state.shown = { kind: "example", analysis: state.example.analysis, inputs: state.example.inputs, pricesAt: state.example.source.fetched_at };
  state.range = "All";
  state.highlight = null;
  renderResults();
}

// ---------- Results ----------

function renderLabel() {
  const shown = state.shown;
  const a = shown.analysis;
  const span = `${longDate(a.start_date)} to ${longDate(a.end_date)}, ${a.observations} daily returns.`;
  const label = $("#result-label");
  label.dataset.kind = shown.kind;
  if (shown.kind === "example") {
    $("#results-title").textContent = "Example analysis";
    label.replaceChildren(
      el("p", {}, [el("strong", { text: "Example data, precomputed." }), ` ${holdingsSummary(shown.inputs.holdings)}. ${span}`]),
      el("p", { class: "muted", text: `Prices fetched ${longDate(shown.pricesAt.slice(0, 10))} from Yahoo Finance. Not a live result.` })
    );
  } else {
    $("#results-title").textContent = "Live analysis";
    const prices = shown.pricesAt ? `Prices from Yahoo Finance, fetched ${timeStamp(shown.pricesAt)}.` : "Prices from Yahoo Finance.";
    label.replaceChildren(
      el("p", {}, [el("strong", { text: "Live result." }), ` ${holdingsSummary(shown.inputs.holdings)}. ${span}`]),
      el("p", { class: "muted" }, [
        `${prices} Calculated ${timeStamp(shown.computedAt)}. `,
        el("button", { type: "button", class: "link-button", text: "Show the example again", onclick: showExample }),
      ])
    );
  }
}

function updateStaleNote() {
  const note = $("#stale-note");
  const stale = state.shown?.kind === "live" && state.shown.version !== state.inputsVersion;
  note.hidden = !stale;
  note.textContent = stale ? "You have changed the inputs since this live result was calculated. Run live analysis to update it." : "";
}

const NOTES = {
  total_return: () => "First trading day to last, dividends included.",
  annualized_return: () => "The yearly rate that compounds to the total.",
  annualized_volatility: () => "How widely daily returns swung, scaled to a year.",
  max_drawdown: (a) => {
    const fall = deepestFall(a.drawdown.values);
    return fall ? `Deepest fall from a running peak, on ${longDate(a.drawdown.dates[fall.low])}.` : "Deepest fall from a running peak.";
  },
  sharpe_ratio: (a, inputs) => `Return above a ${percentInput(inputs.risk_free_rate)}% risk-free rate per unit of volatility.`,
};
const UNDEFINED = {
  total_return: "Undefined for this sample.",
  annualized_return: "Undefined for this sample.",
  annualized_volatility: "Needs at least two daily returns.",
  max_drawdown: "Undefined for this sample.",
  sharpe_ratio: "Undefined: excess returns did not vary.",
};
const METRICS = [
  ["total_return", "Total return", (v) => percent(v, 1, { sign: true })],
  ["annualized_return", "Annualized return", (v) => percent(v)],
  ["annualized_volatility", "Volatility", (v) => percent(v)],
  ["max_drawdown", "Max drawdown", (v) => percent(v)],
  ["sharpe_ratio", "Sharpe ratio", ratio],
];

function countUp(node, target, format) {
  if (!motion) return;
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / 1100);
    node.textContent = format(target * (1 - (1 - p) ** 3));
    if (p < 1) requestAnimationFrame(tick);
    else node.textContent = format(target);
  };
  requestAnimationFrame(tick);
}

function renderMetrics() {
  const { analysis: a, inputs } = state.shown;
  const cells = METRICS.map(([key, name, format]) => {
    const value = a.metrics[key];
    const defined = value !== null && value !== undefined;
    const valueEl = el("dd", { class: `metric-value display num${key === "max_drawdown" ? " risk" : ""}`, text: defined ? format(value) : "—" });
    if (defined) metricAnimations.push(() => countUp(valueEl, value, format));
    return el("div", { class: "metric" }, [
      el("dt", { text: name }),
      valueEl,
      el("dd", { class: "metric-note", text: defined ? NOTES[key](a, inputs) : UNDEFINED[key] }),
    ]);
  });
  $("#metrics").replaceChildren(...cells);
}

let metricAnimations = [];
let metricsObserver = null;
function animateMetricsWhenVisible() {
  metricsObserver?.disconnect();
  if (!motion || !("IntersectionObserver" in window)) return;
  metricsObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    metricsObserver.disconnect();
    metricAnimations.forEach((run) => run());
    metricAnimations = [];
  }, { threshold: 0.5 });
  metricsObserver.observe($("#metrics"));
}

function growthReadout(dates, portfolio, assets, i) {
  const node = $("#growth-readout");
  if (i === null) i = dates.length - 1;
  const others = Object.entries(assets)
    .filter(([, values]) => values[i] != null)
    .sort((x, y) => y[1][i] - x[1][i]);
  const listed = others.slice(0, 4).map(([symbol, values]) => `${symbol} ${dollars(values[i])}`);
  const more = others.length > 4 ? `, and ${others.length - 4} more` : "";
  node.replaceChildren(
    el("strong", { text: longDate(dates[i]) }),
    ` Portfolio ${dollars(portfolio[i])}.`,
    listed.length ? ` ${listed.join(", ")}${more}.` : ""
  );
}

function renderGrowth() {
  const a = state.shown.analysis;
  const ranges = dateRanges(a.portfolio_value.dates);
  if (!ranges.some((r) => r.label === state.range)) state.range = "All";
  const range = ranges.find((r) => r.label === state.range);
  const dates = a.portfolio_value.dates.slice(range.start, range.end + 1);
  const portfolio = rebase(a.portfolio_value.values, range.start, range.end);
  const assets = Object.fromEntries(Object.entries(a.normalized_assets.series).map(([s, v]) => [s, rebase(v, range.start, range.end)]));
  const [lo, hi] = extent([portfolio, ...Object.values(assets)]);
  const ticks = niceTicks(Math.min(lo, 1), hi, 7);

  $("#growth-ranges").replaceChildren(
    ...(ranges.length > 1 ? ranges : []).map((r) =>
      el("button", {
        type: "button",
        class: "chip",
        "aria-pressed": String(r.label === state.range),
        text: r.label,
        onclick: () => {
          state.range = r.label;
          renderGrowth();
        },
      })
    )
  );
  const symbols = Object.keys(assets);
  $("#growth-legend").replaceChildren(
    el("span", { class: "legend-portfolio", text: "Portfolio" }),
    ...symbols.map((symbol) =>
      el("button", {
        type: "button",
        class: "legend-item",
        "aria-pressed": String(state.highlight === symbol),
        text: symbol,
        onclick: () => {
          state.highlight = state.highlight === symbol ? null : symbol;
          renderGrowth();
        },
      })
    )
  );
  const end = portfolio[portfolio.length - 1];
  const name = range.label === "All" ? `${longDate(dates[0])} to ${longDate(dates[dates.length - 1])}` : range.label;
  $("#growth-summary").textContent = `${name}: $1 became ${dollars(end)} (${percent(end - 1, 1, { sign: true })}).`;
  const series = [
    ...symbols.map((symbol) => ({ key: symbol, values: assets[symbol], className: `asset${state.highlight === symbol ? " on" : ""}${state.highlight && state.highlight !== symbol ? " dim" : ""}` })),
    { values: portfolio, className: "portfolio" },
  ];
  // Draw the highlighted holding last among the holdings so it sits on top of the others.
  if (state.highlight) series.sort((x, y) => (x.key === state.highlight) - (y.key === state.highlight));
  series.push(series.splice(series.findIndex((s) => s.className === "portfolio"), 1)[0]);
  timeChart($("#growth-chart"), {
    dates,
    series,
    scale: { ...ticks, format: (v) => `$${v.toFixed(2)}` },
    label: `Growth of $1 for the portfolio and each holding, ${name}. The portfolio ends at ${dollars(end)}. Use the arrow keys to read a day.`,
    onHover: (i) => growthReadout(dates, portfolio, assets, i),
  });
  growthReadout(dates, portfolio, assets, null);
}

function renderDrawdown() {
  const a = state.shown.analysis;
  const { dates, values } = a.drawdown;
  const fall = deepestFall(values);
  const [lo] = extent([values]);
  const ticks = niceTicks(Math.min(lo, -0.01), 0, 4);
  if (fall) {
    const recovery = fall.recovered === null
      ? `Still below that peak on ${longDate(dates[dates.length - 1])}.`
      : `Back above it on ${longDate(dates[fall.recovered])}.`;
    $("#dd-summary").textContent = `Deepest: ${percent(fall.depth)} on ${longDate(dates[fall.low])}, from a ${longDate(dates[fall.peak])} peak. ${recovery}`;
  } else {
    $("#dd-summary").textContent = "The portfolio never fell below an earlier high in this window.";
  }
  const readout = (i) => {
    if (i === null) i = fall ? fall.low : dates.length - 1;
    const d = values[i];
    $("#dd-readout").replaceChildren(el("strong", { text: longDate(dates[i]) }), d > -0.0005 ? " At its high." : ` ${percent(d)} from its peak.`);
  };
  timeChart($("#dd-chart"), {
    dates,
    series: [{ values, className: "dd", area: true }],
    scale: { ...ticks, zeroLine: true, format: (v) => (v === 0 ? "0%" : percent(v, 0)) },
    label: `Drawdown from the running peak.${fall ? ` Deepest ${percent(Math.abs(fall.depth))} on ${longDate(dates[fall.low])}.` : ""} Use the arrow keys to read a day.`,
    onHover: readout,
  });
  readout(null);
}

function renderVolatility() {
  const { analysis: a, inputs } = state.shown;
  const returns = dailyReturns(a.portfolio_value.values);
  const host = $("#vol-chart");
  if (returns.length < 2) {
    host.replaceChildren(el("p", { class: "muted small", text: "Not enough daily returns to show their spread." }));
    $("#vol-summary").textContent = "";
    $("#vol-note").textContent = "";
    return;
  }
  const values = returns.map((r) => r.value);
  const sd = sampleStdev(values);
  const worst = returns.reduce((x, y) => (y.value < x.value ? y : x));
  const best = returns.reduce((x, y) => (y.value > x.value ? y : x));
  const dates = a.portfolio_value.dates;
  const vol = a.metrics.annualized_volatility;
  $("#vol-summary").textContent = `A typical day moved the portfolio about ${percent(sd, 2)} either way. Scaled by √252 trading days, that is ${vol == null ? "undefined" : percent(vol)} a year.`;
  returnsHistogram(host, values, { sd, format: (v) => (v === 0 ? "0%" : percent(v, Math.abs(v) < 0.01 ? 1 : 0)) });
  host.querySelector(".plot").setAttribute("role", "img");
  host.querySelector(".plot").setAttribute("aria-label", `Histogram of ${values.length} daily returns. Worst ${percent(worst.value)} on ${longDate(dates[worst.index])}, best ${percent(best.value, 1, { sign: true })} on ${longDate(dates[best.index])}.`);
  const sharpe = a.metrics.sharpe_ratio;
  $("#vol-note").textContent = `Worst day ${percent(worst.value)} on ${longDate(dates[worst.index])}. Best day ${percent(best.value, 1, { sign: true })} on ${longDate(dates[best.index])}. Bars outside the lines are days beyond one standard deviation. ${sharpe == null ? "The Sharpe ratio is undefined for this sample." : `Sharpe ratio ${ratio(sharpe)}: the average daily return above the ${percentInput(inputs.risk_free_rate)}% risk-free rate, divided by how much it varied, scaled to a year.`}`;
}

function renderCorrelation() {
  const { symbols, matrix } = state.shown.analysis.correlation;
  const table = $("#correlation");
  const head = el("tr", {}, [el("td"), ...symbols.map((s) => el("th", { scope: "col", text: s }))]);
  const rows = matrix.map((values, i) =>
    el("tr", {}, [
      el("th", { scope: "row", text: symbols[i] }),
      ...values.map((value, j) => {
        if (value === null) return el("td", { class: "undefined", title: `${symbols[i]} and ${symbols[j]}: undefined, constant prices`, text: "—" });
        const strength = Math.min(Math.abs(value), 1);
        const style = value >= 0 ? `--a:${(0.08 + strength * 0.82).toFixed(3)}` : `--a:${(0.12 + strength * 0.7).toFixed(3)}`;
        return el("td", { class: `${value >= 0 ? "pos" : "neg"}${strength >= 0.45 && value >= 0 ? " strong" : ""}`, style, title: `${symbols[i]} and ${symbols[j]}: ${ratio(value)}`, text: ratio(value) });
      }),
    ])
  );
  table.replaceChildren(el("thead", {}, head), el("tbody", {}, rows));
}

function renderResults() {
  renderLabel();
  updateStaleNote();
  const warnings = state.shown.analysis.warnings;
  $("#warnings").replaceChildren(...warnings.map((text) => el("li", { text })));
  $("#warnings").hidden = !warnings.length;
  metricAnimations = [];
  renderMetrics();
  renderGrowth();
  renderDrawdown();
  renderVolatility();
  renderCorrelation();
  animateMetricsWhenVisible();
}

// ---------- Saved portfolios (this browser only) ----------

const store = openStore();

function setSavedStatus(message, isError = false) {
  const status = $("#saved-status");
  status.textContent = message;
  status.classList.toggle("error-text", isError);
}

function renderSaved() {
  if (!store) {
    $("#saved-intro").textContent = "This browser is blocking site storage (for example in a private window), so saving is turned off here. Nothing is ever saved on the server.";
    $("#save-form").hidden = true;
    return;
  }
  const items = readSaved(store);
  $("#saved-summary-count").textContent = items.length ? ` (${items.length})` : "";
  $("#saved-list").replaceChildren(
    ...(items.length ? items.map(savedItem) : [el("li", { class: "muted small", text: "Nothing saved in this browser yet." })])
  );
}

function savedItem(portfolio) {
  const symbols = portfolio.holdings.map((h) => h.symbol).filter(Boolean).join(", ") || "No symbols";
  const span = portfolio.start_date && portfolio.end_date ? ` ${longDate(portfolio.start_date)} to ${longDate(portfolio.end_date)}.` : "";
  return el("li", {}, [
    el("div", {}, [el("p", { class: "saved-name", text: portfolio.name }), el("p", { class: "muted small", text: `${symbols}.${span}` })]),
    el("button", { type: "button", class: "btn btn-quiet btn-small", text: "Load", "aria-label": `Load ${portfolio.name}`, onclick: () => loadSaved(portfolio) }),
    el("button", { type: "button", class: "btn btn-quiet btn-small danger", text: "Delete", "aria-label": `Delete ${portfolio.name}`, onclick: () => deleteSaved(portfolio) }),
  ]);
}

function saveCurrent(event) {
  event.preventDefault();
  if (!store) return;
  const nameError = document.querySelector('[data-error-for="name"]');
  nameError.textContent = "";
  $("#portfolio-name").classList.remove("invalid");
  try {
    const { entry, replaced } = savePortfolio(store, $("#portfolio-name").value, readForm());
    $("#portfolio-name").value = "";
    setSavedStatus(`${replaced ? "Updated" : "Saved"} \u201c${entry.name}\u201d in this browser.`);
    renderSaved();
  } catch (error) {
    nameError.textContent = error.message || "Could not save in this browser.";
    markInvalid($("#portfolio-name"));
    $("#portfolio-name").focus();
  }
}

function loadSaved(portfolio) {
  fillForm(portfolio);
  inputsChanged();
  setSavedStatus(`Loaded \u201c${portfolio.name}\u201d. Run live analysis to see its results.`);
}

function deleteSaved(portfolio) {
  if (!window.confirm(`Delete \u201c${portfolio.name}\u201d from this browser?`)) return;
  deletePortfolio(store, portfolio.id);
  setSavedStatus(`Deleted \u201c${portfolio.name}\u201d.`);
  renderSaved();
}

// ---------- Start ----------

function renderHeroCopy(example) {
  const a = example.analysis;
  const values = a.portfolio_value.values;
  const end = values[values.length - 1];
  const fall = deepestFall(a.drawdown.values);
  const names = { AAPL: "Apple", MSFT: "Microsoft", GOOG: "Alphabet" };
  const mix = example.inputs.holdings.map((h) => `${Number((h.weight * 100).toFixed(2))}% ${names[h.symbol] || h.symbol}`);
  const list = mix.length > 1 ? `${mix.slice(0, -1).join(", ")} and ${mix[mix.length - 1]}` : mix[0];
  $("#hero-label").replaceChildren(
    el("strong", { text: "Example portfolio." }),
    ` ${list}, bought ${longDate(a.start_date)} and held to ${longDate(a.end_date)}.`
  );
  $("#hero-line-1").textContent = end >= 1 ? `$1 grew to ${dollars(end)}.` : `$1 fell to ${dollars(end)}.`;
  $("#hero-line-2").textContent = fall ? `It also fell ${percent(Math.abs(fall.depth))}.` : "It never fell below a high.";
  $("#readout-source").textContent = `Example data. Prices fetched ${longDate(example.source.fetched_at.slice(0, 10))} from Yahoo Finance.`;
}

async function start() {
  $("#portfolio-form").addEventListener("submit", runLive);
  $("#portfolio-form").addEventListener("input", inputsChanged);
  $("#add-holding").addEventListener("click", () => {
    addHoldingRow();
    holdingsEl.lastElementChild?.querySelector(".symbol").focus();
    inputsChanged();
  });
  $("#save-form").addEventListener("submit", saveCurrent);
  renderSaved();
  // Another tab of this site saving or deleting updates this list too.
  window.addEventListener("storage", () => store && renderSaved());
  const today = new Date().toISOString().slice(0, 10);
  $("#start-date").max = today;
  $("#end-date").max = today;

  const service = watchService(setService);
  $("#retry-service").addEventListener("click", () => service.retry());

  try {
    const response = await fetch("static/example-analysis.json");
    if (!response.ok) throw new Error(String(response.status));
    state.example = await response.json();
  } catch {
    $("#hero-label").textContent = "The precomputed example could not be loaded. Run a live analysis below instead.";
    $("#result-label").textContent = "No example available.";
    addHoldingRow();
    return;
  }
  renderHeroCopy(state.example);
  renderHero({
    host: $("#horizon"),
    readout: { date: $("#readout-date"), value: $("#readout-value"), fall: $("#readout-fall"), hint: $("#readout-hint") },
    result: state.example.analysis,
  });
  fillForm(state.example.inputs);
  updateHoldingControls();
  showExample();
}

start();
