// Pure helpers over the arrays returned by POST /api/v1/analyze. No DOM access here, so they can be unit tested.

const AT_PEAK = -1e-12;

// Daily simple returns of a value series, skipping gaps. Matches pandas pct_change().dropna().
export function dailyReturns(values) {
  const out = [];
  for (let i = 1; i < values.length; i += 1) {
    const before = values[i - 1];
    const after = values[i];
    if (before != null && after != null && before !== 0) out.push({ index: i, value: after / before - 1 });
  }
  return out;
}

export function sampleStdev(numbers) {
  if (numbers.length < 2) return null;
  const mean = numbers.reduce((sum, x) => sum + x, 0) / numbers.length;
  const variance = numbers.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (numbers.length - 1);
  return Math.sqrt(variance);
}

// The deepest drawdown episode: the peak before the low, the low itself, and the first day back at the peak.
export function deepestFall(drawdown) {
  let low = -1;
  drawdown.forEach((value, i) => {
    if (value != null && (low < 0 || value < drawdown[low])) low = i;
  });
  if (low < 0 || drawdown[low] >= AT_PEAK) return null;
  let peak = low;
  while (peak > 0 && !(drawdown[peak] >= AT_PEAK)) peak -= 1;
  let recovered = null;
  for (let i = low + 1; i < drawdown.length; i += 1) {
    if (drawdown[i] >= AT_PEAK) {
      recovered = i;
      break;
    }
  }
  return { peak, low, recovered, depth: drawdown[low] };
}

// "All" plus every calendar year with enough trading days to be worth its own view.
export function dateRanges(dates, minDays = 20) {
  const ranges = [{ label: "All", start: 0, end: dates.length - 1 }];
  const years = new Map();
  dates.forEach((iso, i) => {
    const year = iso.slice(0, 4);
    if (!years.has(year)) years.set(year, { label: year, start: i, end: i });
    years.get(year).end = i;
  });
  if (years.size > 1) {
    for (const range of years.values()) if (range.end - range.start + 1 >= minDays) ranges.push(range);
  }
  return ranges;
}

export function rebase(values, start, end) {
  const base = values[start];
  return values.slice(start, end + 1).map((v) => (v == null || base == null ? null : v / base));
}

export function extent(arrays) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const array of arrays) {
    for (const v of array) {
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return [lo, hi];
}

// Evenly spaced round tick values covering [lo, hi]: the finest round step that needs at most maxTicks + 1 ticks.
export function niceTicks(lo, hi, maxTicks = 5) {
  if (!(hi > lo)) return { lo: lo - 0.5, hi: hi + 0.5, step: 0.5, ticks: [lo] };
  const power = 10 ** Math.floor(Math.log10((hi - lo) / maxTicks));
  const steps = [1, 2, 2.5, 5, 10, 20].map((m) => m * power);
  const step = steps.find((s) => Math.ceil(hi / s - 1e-9) - Math.floor(lo / s + 1e-9) + 1 <= maxTicks + 1) ?? steps[steps.length - 1];
  const first = Math.floor(lo / step + 1e-9) * step;
  const last = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let t = first; t <= last + step / 2; t += step) ticks.push(Number(t.toFixed(10)) + 0); // + 0 turns -0 into 0
  return { lo: first, hi: last, step, ticks };
}

// Histogram of returns with a round bin width chosen so there are at most about maxBins bins.
export function histogram(returns, maxBins = 48) {
  const [lo, hi] = extent([returns]);
  const width = [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05].find((w) => (hi - lo) / w <= maxBins) ?? 0.1;
  const start = Math.floor(lo / width) * width;
  const count = Math.max(1, Math.ceil((hi - start) / width + 1e-9));
  const bins = Array.from({ length: count }, (_, i) => ({ lo: start + i * width, hi: start + (i + 1) * width, count: 0 }));
  for (const r of returns) bins[Math.min(count - 1, Math.floor((r - start) / width + 1e-9))].count += 1;
  return { width, bins };
}
