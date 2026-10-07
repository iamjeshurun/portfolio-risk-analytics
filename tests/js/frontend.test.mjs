// Run with: node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { dollars, longDate, percent, percentInput, toDecimal } from "../../app/static/js/format.js";
import { dailyReturns, dateRanges, deepestFall, histogram, niceTicks, rebase, sampleStdev } from "../../app/static/js/series.js";

const example = JSON.parse(readFileSync(new URL("../../app/static/example-analysis.json", import.meta.url)));
const analysis = example.analysis;

test("formats use a real minus sign and never shift dates", () => {
  assert.equal(percent(-0.26867), "−26.9%");
  assert.equal(percent(1.4871, 1, { sign: true }), "+148.7%");
  assert.equal(percent(-0.00001), "0.0%");
  assert.equal(dollars(2.4871), "$2.49");
  assert.equal(longDate("2025-04-08"), "Apr 8, 2025");
  assert.equal(percentInput(0.35), "35");
  assert.equal(toDecimal("35"), 0.35);
  assert.equal(toDecimal(""), null);
  assert.equal(toDecimal("abc"), null);
});

test("daily returns reproduce the API's annualized volatility", () => {
  const returns = dailyReturns(analysis.portfolio_value.values).map((r) => r.value);
  assert.equal(returns.length, analysis.observations);
  const annualized = sampleStdev(returns) * Math.sqrt(252);
  assert.ok(Math.abs(annualized - analysis.metrics.annualized_volatility) < 1e-9);
});

test("the deepest fall matches the API's maximum drawdown and its dates", () => {
  const fall = deepestFall(analysis.drawdown.values);
  const dates = analysis.drawdown.dates;
  assert.equal(fall.depth, analysis.metrics.max_drawdown);
  assert.equal(dates[fall.low], "2025-04-08");
  assert.equal(dates[fall.peak], "2024-12-17");
  assert.equal(dates[fall.recovered], "2025-08-08");
});

test("a drawdown that never recovers reports no recovery day", () => {
  assert.deepEqual(deepestFall([0, -0.1, -0.3, -0.2]), { peak: 0, low: 2, recovered: null, depth: -0.3 });
  assert.equal(deepestFall([0, 0, 0]), null);
});

test("date ranges are All plus each calendar year", () => {
  const ranges = dateRanges(analysis.portfolio_value.dates);
  assert.deepEqual(ranges.map((r) => r.label), ["All", "2023", "2024", "2025"]);
  const y2024 = ranges[2];
  const rebased = rebase(analysis.portfolio_value.values, y2024.start, y2024.end);
  assert.equal(rebased[0], 1);
  assert.equal(rebased.at(-1).toFixed(3), "1.284");
  assert.deepEqual(dateRanges(["2024-01-02", "2024-01-03"]).map((r) => r.label), ["All"]);
});

test("axis ticks are round and cover the data", () => {
  assert.deepEqual(niceTicks(0.95, 3.6, 7).ticks, [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  assert.deepEqual(niceTicks(-0.27, 0, 4).ticks, [-0.3, -0.2, -0.1, 0]);
});

test("the histogram counts every return once", () => {
  const values = dailyReturns(analysis.portfolio_value.values).map((r) => r.value);
  const { bins } = histogram(values);
  assert.equal(bins.reduce((sum, b) => sum + b.count, 0), values.length);
  assert.ok(bins.length <= 48);
});
