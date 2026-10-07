const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUS = "−";

// "2025-04-08" -> "Apr 8, 2025" without going through Date, so time zones never shift the day.
export function longDate(iso) {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

export function monthYear(iso) {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

export function percent(value, digits = 1, { sign = false } = {}) {
  const text = `${Math.abs(value * 100).toFixed(digits)}%`;
  if (value < 0 && Number((value * 100).toFixed(digits)) !== 0) return `${MINUS}${text}`;
  return sign && value > 0 ? `+${text}` : text;
}

export function dollars(value) {
  return `$${value.toFixed(2)}`;
}

export function ratio(value) {
  return value < 0 ? `${MINUS}${Math.abs(value).toFixed(2)}` : value.toFixed(2);
}

// Weights as typed into the form: 0.4 -> "40", 0.333333 -> "33.3333".
export function percentInput(decimal) {
  return String(Number((decimal * 100).toFixed(6)));
}

export function toDecimal(percentText) {
  const text = String(percentText).trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? Number((value / 100).toFixed(10)) : null;
}

export function holdingsSummary(holdings) {
  return holdings.map((h) => `${h.symbol} ${Number((h.weight * 100).toFixed(2))}%`).join(", ");
}

export function timeStamp(isoOrDate) {
  const value = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
