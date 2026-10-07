// The API can live on another host (the static site on GitHub Pages talks to the service on Render).
// index.html carries it in <meta name="api-base">; empty means same origin.
const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");

export async function api(path, { method = "GET", body, timeout = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } catch {
    throw {
      code: "NETWORK_ERROR",
      message: controller.signal.aborted
        ? "The analysis service took too long to answer. Try again."
        : "Could not reach the analysis service. Try again in a moment.",
    };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw data?.error || { code: "HTTP_ERROR", message: `The analysis service answered with status ${response.status}.` };
  }
  return data;
}

// Free hosting sleeps when idle, so the first health check can take most of a minute.
// States: "checking" -> "waking" (no answer within a few seconds) -> "ready" or "unavailable".
export function watchService(onChange, { giveUpAfter = 120000, retryEvery = 5000 } = {}) {
  let run = 0; // each start() gets a number so a retry cancels the previous loop
  let startedAt = 0;
  let wakingTimer = null;

  async function attempt(current) {
    try {
      await api("/api/v1/health", { timeout: 15000 });
      if (current !== run) return;
      clearTimeout(wakingTimer);
      onChange("ready");
    } catch {
      if (current !== run) return;
      if (Date.now() - startedAt > giveUpAfter) {
        clearTimeout(wakingTimer);
        onChange("unavailable");
      } else {
        onChange("waking");
        setTimeout(() => current === run && attempt(current), retryEvery);
      }
    }
  }

  function start() {
    run += 1;
    startedAt = Date.now();
    clearTimeout(wakingTimer);
    onChange("checking");
    const current = run;
    wakingTimer = setTimeout(() => current === run && onChange("waking"), 2500);
    attempt(current);
  }

  start();
  return { retry: start, stop: () => (run += 1) };
}
