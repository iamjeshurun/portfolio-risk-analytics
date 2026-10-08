// Saved portfolios live in the visitor's own browser (localStorage), never on the server, so visitors to the
// public demo cannot see or delete each other's. Only the inputs are kept, not results.

const KEY = "portfolio-risk-analytics:saved-portfolios:v1";
export const MAX_SAVED = 50;

export function openStore(storage = globalThis.localStorage) {
  try {
    const probe = `${KEY}:probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null; // private browsing modes and blocked site data
  }
}

export function readSaved(storage) {
  try {
    const items = JSON.parse(storage.getItem(KEY) || "[]");
    return Array.isArray(items) ? items.filter((item) => item && typeof item.name === "string" && Array.isArray(item.holdings)) : [];
  } catch {
    return [];
  }
}

function write(storage, items) {
  storage.setItem(KEY, JSON.stringify(items));
}

// Returns the saved entry, or throws an Error whose message can be shown next to the name field.
export function savePortfolio(storage, name, inputs, now = new Date()) {
  const clean = name.trim();
  if (!clean) throw new Error("Enter a name.");
  if (clean.length > 100) throw new Error("Use at most 100 characters.");
  const items = readSaved(storage);
  const existing = items.findIndex((item) => item.name.toLowerCase() === clean.toLowerCase());
  if (existing < 0 && items.length >= MAX_SAVED) throw new Error(`This browser already holds ${MAX_SAVED} saved portfolios. Delete one first.`);
  const entry = {
    id: existing >= 0 ? items[existing].id : `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: clean,
    holdings: inputs.holdings.map((h) => ({ symbol: String(h.symbol).trim().toUpperCase(), weight: h.weight })),
    start_date: inputs.start_date,
    end_date: inputs.end_date,
    risk_free_rate: inputs.risk_free_rate,
    saved_at: now.toISOString(),
  };
  if (existing >= 0) items.splice(existing, 1);
  write(storage, [entry, ...items]);
  return { entry, replaced: existing >= 0 };
}

export function deletePortfolio(storage, id) {
  write(storage, readSaved(storage).filter((item) => item.id !== id));
}
