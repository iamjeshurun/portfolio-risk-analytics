"use strict";

const MAX_HOLDINGS = 20;
const SERIES_SLOTS = 8;
const EXAMPLE = {
  holdings: [
    { symbol: "AAPL", weight: 0.4 },
    { symbol: "MSFT", weight: 0.35 },
    { symbol: "GOOG", weight: 0.25 },
  ],
  start_date: "2023-01-01",
  end_date: "2025-12-31",
  risk_free_rate: 0.04,
};
const METRIC_KEYS = ["total_return", "annualized_return", "annualized_volatility", "max_drawdown", "sharpe_ratio"];
const UNDEFINED_REASONS = {
  total_return: "Undefined for this sample.",
  annualized_return: "Undefined for this sample.",
  annualized_volatility: "Needs at least two return observations.",
  max_drawdown: "Undefined for this sample.",
  sharpe_ratio: "Undefined: excess returns show no variation.",
};

const $ = (selector) => document.querySelector(selector);
const holdingsEl = $("#holdings");
const form = $("#portfolio-form");
const charts = { performance: null, drawdown: null };
let lastResult = null;
let inputsVersion = 0; // incremented on every input change so stale results and responses can be detected

// ---------- Formatting ----------

const percent = (value) => `${(value * 100).toFixed(2)}%`;
const ratio = (value) => value.toFixed(2);

function localISODate(day) {
  const offset = day.getTimezoneOffset() * 60000;
  return new Date(day.getTime() - offset).toISOString().slice(0, 10);
}

function percentInput(decimal) {
  return String(Number((decimal * 100).toFixed(6)));
}

function toDecimal(percentText) {
  if (percentText.trim() === "") return null;
  const value = Number(percentText);
  return Number.isFinite(value) ? Number((value / 100).toFixed(10)) : null;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- Holdings rows ----------

function addHoldingRow(symbol = "", weightPercent = "") {
  if (holdingsEl.children.length >= MAX_HOLDINGS) return;
  const row = $("#holding-row").content.firstElementChild.cloneNode(true);
  row.querySelector(".symbol").value = symbol;
  row.querySelector(".weight").value = weightPercent;
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    if (holdingsEl.children.length === 0) addHoldingRow();
    updateHoldingControls();
    markInputsChanged();
  });
  row.querySelector(".weight").addEventListener("input", updateHoldingControls);
  holdingsEl.appendChild(row);
  updateHoldingControls();
}

function updateHoldingControls() {
  const rows = [...holdingsEl.children];
  const total = rows.reduce((sum, row) => sum + (Number(row.querySelector(".weight").value) || 0), 0);
  const totalEl = $("#weight-total");
  totalEl.textContent = `${total.toFixed(2)}%`;
  totalEl.parentElement.classList.toggle("ok", Math.abs(total - 100) < 0.0001);
  totalEl.parentElement.classList.toggle("off", Math.abs(total - 100) >= 0.0001);
  $("#add-holding").disabled = rows.length >= MAX_HOLDINGS;
  $("#add-holding").title = rows.length >= MAX_HOLDINGS ? `A portfolio can hold at most ${MAX_HOLDINGS} symbols.` : "";
}

function fillForm(config) {
  holdingsEl.replaceChildren();
  config.holdings.forEach((h) => addHoldingRow(h.symbol, percentInput(h.weight)));
  $("#start-date").value = config.start_date;
  $("#end-date").value = config.end_date;
  $("#risk-free-rate").value = percentInput(config.risk_free_rate);
  clearErrors();
  markInputsChanged();
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

// ---------- Errors ----------

function clearErrors() {
  document.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
  document.querySelectorAll("input.invalid").forEach((el) => el.classList.remove("invalid"));
  $("#request-error").hidden = true;
  $("#request-error").replaceChildren();
}

function setFieldError(field, message) {
  const holding = field.match(/^holdings\.(\d+)(?:\.(symbol|weight))?$/);
  if (holding) {
    const row = holdingsEl.children[Number(holding[1])];
    if (!row) return false;
    if (holding[2]) row.querySelector(`.${holding[2]}`).classList.add("invalid");
    appendText(row.querySelector(".row-error"), message);
    return true;
  }
  const target = document.querySelector(`[data-error-for="${field}"]`);
  if (!target) return false;
  appendText(target, message);
  const input = target.closest(".field")?.querySelector("input");
  if (input) input.classList.add("invalid");
  return true;
}

function appendText(el, message) {
  el.textContent = el.textContent ? `${el.textContent} ${message}` : message;
}

const SYMBOL_ERROR_LABELS = {
  NO_DATA: "No usable price data for this range.",
  MISSING_DATA: "Missing prices on dates other holdings traded.",
  PROVIDER_ERROR: "The provider returned invalid prices.",
};

function showRequestError(error) {
  const box = $("#request-error");
  const unplaced = [];
  const details = error.details || {};

  if (error.code === "VALIDATION_ERROR") {
    for (const item of details.errors || []) {
      if (!setFieldError(item.field, item.message)) unplaced.push(`${item.field}: ${item.message}`);
    }
  }
  if (details.symbols && SYMBOL_ERROR_LABELS[error.code]) {
    for (const row of holdingsEl.children) {
      const symbol = row.querySelector(".symbol").value.trim().toUpperCase();
      if (details.symbols.includes(symbol)) {
        row.querySelector(".symbol").classList.add("invalid");
        appendText(row.querySelector(".row-error"), SYMBOL_ERROR_LABELS[error.code]);
      }
    }
  }

  const heading = document.createElement("strong");
  heading.textContent = error.code === "VALIDATION_ERROR" ? "Please correct the highlighted fields." : error.message;
  box.replaceChildren(heading);
  const extra = [...unplaced];
  if (details.dates?.length) extra.push(`Affected dates include ${details.dates.join(", ")}.`);
  if (error.code === "INSUFFICIENT_DATA" && details.observations !== undefined) {
    extra.push(`Available return observations: ${details.observations}.`);
  }
  if (extra.length) {
    const list = document.createElement("ul");
    extra.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    });
    box.appendChild(list);
  }
  box.hidden = false;
}

function revealError() {
  const firstInvalid = document.querySelector("input.invalid");
  if (firstInvalid) firstInvalid.focus();
  else $("#request-error").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- API ----------

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw { code: "NETWORK_ERROR", message: "Could not reach the server. Check that it is running and try again." };
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw data?.error || { code: "HTTP_ERROR", message: `The server responded with status ${response.status}.` };
  }
  return data;
}

// ---------- Analysis ----------

function setView(view) {
  $("#empty-state").hidden = view !== "empty";
  $("#loading-state").hidden = view !== "loading";
  $("#results").hidden = view !== "results";
}

function markInputsChanged() {
  inputsVersion += 1;
  if ($("#results").hidden && $("#loading-state").hidden) return;
  lastResult = null;
  $("#empty-title").textContent = "Inputs changed";
  $("#empty-message").textContent = "The previous results no longer match these inputs. Choose Analyze to update them.";
  setView("empty");
}

async function analyze(event) {
  event.preventDefault();
  clearErrors();
  const button = $("#analyze-button");
  button.disabled = true;
  button.textContent = "Analyzing…";
  setView("loading");
  const requestVersion = inputsVersion;
  try {
    const result = await api("/api/v1/analyze", { method: "POST", body: JSON.stringify(readForm()) });
    if (requestVersion !== inputsVersion) return; // inputs changed while the request was running
    lastResult = result;
    renderResults(lastResult);
    setView("results");
    if (window.innerWidth <= 860) $("#results").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    if (requestVersion !== inputsVersion) return;
    showRequestError(error);
    setView("none");
    revealError();
  } finally {
    button.disabled = false;
    button.textContent = "Analyze";
  }
}

function renderResults(result) {
  const period = $("#period");
  period.replaceChildren(
    "Effective analysis period: ",
    Object.assign(document.createElement("strong"), { textContent: `${result.start_date} to ${result.end_date}` }),
    ` · ${result.observations} daily return observations`
  );

  const warnings = $("#warnings");
  warnings.replaceChildren(
    ...result.warnings.map((text) => Object.assign(document.createElement("li"), { textContent: text }))
  );
  warnings.hidden = result.warnings.length === 0;

  for (const key of METRIC_KEYS) {
    const value = result.metrics[key];
    const defined = value !== null && value !== undefined;
    $(`#m-${key}`).textContent = defined ? (key === "sharpe_ratio" ? ratio(value) : percent(value)) : "—";
    $(`#n-${key}`).textContent = defined ? "" : UNDEFINED_REASONS[key];
  }

  renderCharts(result);
  renderCorrelation(result.correlation);
}

function renderCharts(result) {
  if (!window.Chart) {
    document.querySelectorAll(".chart-box").forEach((box) => {
      box.textContent = "Charts are unavailable because Chart.js could not be loaded from the CDN.";
    });
    return;
  }
  const grid = cssVar("--grid");
  const text = cssVar("--text-secondary");
  Chart.defaults.color = text;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const symbols = Object.keys(result.normalized_assets.series);
  const assetDatasets = symbols.map((symbol, i) => ({
    label: symbol,
    data: result.normalized_assets.series[symbol],
    borderColor: i < SERIES_SLOTS ? cssVar(`--series-${i + 1}`) : cssVar("--series-other"),
    borderWidth: 1.5,
  }));
  const portfolioDataset = {
    label: "Portfolio",
    data: result.portfolio_value.values,
    borderColor: cssVar("--portfolio"),
    borderWidth: 2.5,
  };

  const baseOptions = (formatValue) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    elements: { point: { radius: 0, hoverRadius: 4 }, line: { tension: 0 } },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: window.innerWidth < 520 ? 3 : 6, maxRotation: 0, autoSkipPadding: 16 } },
      y: { grid: { color: grid }, border: { display: false }, ticks: { callback: formatValue } },
    },
    plugins: {
      legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "line", boxWidth: 24 } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatValue(ctx.parsed.y)}` } },
    },
  });

  charts.performance?.destroy();
  charts.performance = new Chart($("#performance-chart"), {
    type: "line",
    data: { labels: result.portfolio_value.dates, datasets: [portfolioDataset, ...assetDatasets] },
    options: baseOptions((v) => Number(v).toFixed(2)),
  });

  const drawdownOptions = baseOptions((v) => percent(Number(v)));
  drawdownOptions.plugins.legend.display = false;
  drawdownOptions.scales.y.max = 0;
  charts.drawdown?.destroy();
  charts.drawdown = new Chart($("#drawdown-chart"), {
    type: "line",
    data: {
      labels: result.drawdown.dates,
      datasets: [{ label: "Drawdown", data: result.drawdown.values, borderColor: cssVar("--diverging-neg"), borderWidth: 2 }],
    },
    options: drawdownOptions,
  });
}

function mixHex(from, to, amount) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = parse(from);
  const b = parse(to);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(",")})`;
}

function renderCorrelation({ symbols, matrix }) {
  const table = $("#correlation");
  const mid = cssVar("--diverging-mid");
  const head = document.createElement("tr");
  head.appendChild(document.createElement("th"));
  symbols.forEach((symbol) => head.appendChild(Object.assign(document.createElement("th"), { textContent: symbol, scope: "col" })));
  const thead = document.createElement("thead");
  thead.appendChild(head);

  const tbody = document.createElement("tbody");
  matrix.forEach((values, i) => {
    const row = document.createElement("tr");
    row.appendChild(Object.assign(document.createElement("th"), { textContent: symbols[i], scope: "row" }));
    values.forEach((value, j) => {
      const cell = document.createElement("td");
      if (value === null) {
        cell.textContent = "—";
        cell.className = "undefined";
        cell.title = `${symbols[i]} / ${symbols[j]}: undefined (constant prices)`;
      } else {
        const pole = cssVar(value >= 0 ? "--diverging-pos" : "--diverging-neg");
        cell.style.background = mixHex(mid, pole, Math.min(Math.abs(value), 1));
        cell.style.color = Math.abs(value) > 0.55 ? "#ffffff" : cssVar("--text-primary");
        cell.textContent = value.toFixed(2);
        cell.title = `${symbols[i]} / ${symbols[j]}: ${value.toFixed(2)}`;
      }
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  table.replaceChildren(thead, tbody);
}

// ---------- Saved portfolios ----------

function setSavedStatus(message, isError = false) {
  const status = $("#saved-status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function refreshSaved() {
  const list = $("#saved-list");
  try {
    const portfolios = await api("/api/v1/portfolios");
    const empty = Object.assign(document.createElement("li"), { className: "saved-empty", textContent: "No saved portfolios yet." });
    list.replaceChildren(...(portfolios.length ? portfolios.map(savedItem) : [empty]));
  } catch (error) {
    setSavedStatus(`Could not load saved portfolios: ${error.message}`, true);
  }
}

function savedItem(portfolio) {
  const li = document.createElement("li");
  const info = document.createElement("div");
  info.append(
    Object.assign(document.createElement("div"), { className: "saved-name", textContent: portfolio.name }),
    Object.assign(document.createElement("div"), {
      className: "saved-meta",
      textContent: `${portfolio.holdings.map((h) => h.symbol).join(", ")} · ${portfolio.start_date} to ${portfolio.end_date}`,
    })
  );
  const load = Object.assign(document.createElement("button"), { type: "button", className: "button small", textContent: "Load" });
  load.addEventListener("click", () => loadSaved(portfolio.id));
  const remove = Object.assign(document.createElement("button"), { type: "button", className: "button small danger", textContent: "Delete" });
  remove.setAttribute("aria-label", `Delete ${portfolio.name}`);
  remove.addEventListener("click", () => deleteSaved(portfolio));
  li.append(info, load, remove);
  return li;
}

async function saveCurrent(event) {
  event.preventDefault();
  clearErrors();
  const button = $("#save-button");
  button.disabled = true;
  try {
    const saved = await api("/api/v1/portfolios", {
      method: "POST",
      body: JSON.stringify({ name: $("#portfolio-name").value, ...readForm() }),
    });
    $("#portfolio-name").value = "";
    setSavedStatus(`Saved “${saved.name}”.`);
    await refreshSaved();
  } catch (error) {
    showRequestError(error);
    revealError();
    setSavedStatus(error.code === "VALIDATION_ERROR" ? "Not saved: correct the highlighted fields." : error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function loadSaved(id) {
  try {
    const portfolio = await api(`/api/v1/portfolios/${id}`);
    fillForm(portfolio);
    setSavedStatus(`Loaded “${portfolio.name}”. Choose Analyze to run it.`);
  } catch (error) {
    setSavedStatus(error.message, true);
    await refreshSaved();
  }
}

async function deleteSaved(portfolio) {
  if (!window.confirm(`Delete saved portfolio “${portfolio.name}”?`)) return;
  try {
    await api(`/api/v1/portfolios/${portfolio.id}`, { method: "DELETE" });
    setSavedStatus(`Deleted “${portfolio.name}”.`);
  } catch (error) {
    setSavedStatus(error.message, true);
  }
  await refreshSaved();
}

// ---------- Startup ----------

function init() {
  const today = new Date();
  const start = new Date(today);
  start.setFullYear(today.getFullYear() - 3);
  $("#end-date").value = localISODate(today);
  $("#end-date").max = localISODate(today);
  $("#start-date").max = localISODate(today);
  $("#start-date").value = localISODate(start);
  $("#risk-free-rate").value = "3";
  addHoldingRow();

  $("#add-holding").addEventListener("click", () => {
    addHoldingRow();
    markInputsChanged();
  });
  $("#example-button").addEventListener("click", () => fillForm(EXAMPLE));
  form.addEventListener("submit", analyze);
  form.addEventListener("input", markInputsChanged);
  $("#save-form").addEventListener("submit", saveCurrent);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (lastResult) renderResults(lastResult);
  });
  refreshSaved();
}

init();
