# Portfolio Risk Analytics

A small FastAPI application for analyzing a long-only US equity portfolio. You enter symbols, initial weights,
a date range and an annual risk-free rate. The app retrieves daily adjusted closing prices from Yahoo Finance
(via `yfinance`), caches them in SQLite, and reports:

- total and annualized return
- annualized volatility
- maximum drawdown
- Sharpe ratio
- asset return correlations

The dashboard opens on a precomputed, clearly labelled example (40% AAPL, 35% MSFT, 25% GOOG, 2023 to 2025),
so it is useful before the free-tier API wakes up. Edit the holdings and run a live analysis once the service is
ready; live results replace the example and are labelled with when their prices were fetched. You can also save,
load and delete portfolio configurations; the dashboard keeps them in your own browser.

**Live demo:** <https://iamjeshurun.github.io/portfolio-risk-analytics/> (static page on GitHub Pages; the API runs
on Render's free tier and can take up to a minute to wake).

## Architecture

One process and one SQLite file. There is no separate frontend build: the page is plain HTML, CSS and JavaScript
modules with hand-written SVG charts and no runtime dependencies.

```
Browser (app/static: index.html, styles.css, js/*.js, example-analysis.json)
   │  JSON over HTTP
FastAPI app (app/main.py, app/routes.py)
   ├── analysis.py     data-quality rules and response assembly for /analyze
   ├── schemas.py      Pydantic request/response models and input validation
   ├── market_data.py  yfinance fetch_prices() + SQLite price cache
   ├── analytics.py    pure pandas/NumPy financial calculations
   ├── database.py     SQLAlchemy engine, session, and the prices/price_fetches/portfolios tables
   ├── errors.py       AppError and the three error handlers
   └── config.py       environment variables with defaults
SQLite (portfolio.db)
```

The request flow for `POST /api/v1/analyze`:

1. Validate the input.
2. Read cached prices, or fetch them when the cache is insufficient.
3. Apply the data-quality rules.
4. Call the pure analytics functions.
5. Return a validated response model.

The provider is a plain function, `fetch_prices(symbols, start, end)`, exposed through the `get_price_fetcher`
FastAPI dependency, so tests can replace it with `app.dependency_overrides`. The schema is created at startup;
there are no migrations.

## Setup

Requires **Python 3.13**.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start the server (from the project root, with the virtual environment active):

```bash
uvicorn app.main:app
```

Then open <http://127.0.0.1:8000/> for the dashboard, or <http://127.0.0.1:8000/docs> for the Swagger
documentation.

### Configuration

Settings are read from environment variables. `.env.example` documents them, but **the app does not load
`.env` files**. Export any overrides in your shell before starting the server:

```bash
export DATABASE_URL=sqlite:///./portfolio.db   # default
export CACHE_TTL_HOURS=24                      # default
export PROVIDER_TIMEOUT_SECONDS=10             # default
export ALLOWED_ORIGINS=https://iamjeshurun.github.io  # browser origins allowed to call the API; default none
export SAVED_PORTFOLIOS_ENABLED=true           # default; false turns off the /portfolios endpoints
uvicorn app.main:app
```

`ALLOWED_ORIGINS` is only needed when the page is hosted somewhere other than the API, as on GitHub Pages.
`SAVED_PORTFOLIOS_ENABLED=false` makes the `/portfolios` endpoints answer `404 NOT_ENABLED`. The public deployment
uses it, because those endpoints keep one shared list in the server's database that every caller could read and
delete. The dashboard does not use them.

## Deployment

- **API:** `render.yaml` is a Render Blueprint for a free web service that runs `uvicorn` and allows the GitHub
  Pages origin and turns off server-side saved portfolios. The free tier sleeps when idle and its disk is not
  persistent, so the price cache is reset on each restart. Yahoo Finance may also rate-limit requests from cloud servers; the page
  reports that as an error rather than showing stale or invented numbers.
- **Page:** `.github/workflows/pages.yml` copies `app/static` to GitHub Pages and writes the API's address
  (the `API_URL` repository variable) into `<meta name="api-base">`.
- **Example:** `python scripts/build_example.py` refetches prices and rewrites `app/static/example-analysis.json`
  with the fetch time. Nothing in it is hand-written.

## Using the dashboard

The page has two parts:

- **The opening** replays the example portfolio's three years: growth of $1 above a baseline and its fall from the
  running peak below it, one hairline per trading day, with the deepest drawdown marked. Move along it, or focus it
  and use the arrow keys, to read any day.
- **The analysis workspace** shows the summary measures with short explanations, a growth-of-$1 chart with a
  range per calendar year and each holding, the drawdown chart, a histogram of daily returns for volatility and the
  Sharpe ratio, and the correlation table. Every chart can be read with the pointer or the arrow keys.

The results area always says what it shows: **Example data, precomputed** (with the date its prices were fetched)
or **Live result** (with when the prices were fetched and when it was calculated). A live run never silently
replaces the example: on any error the current results stay on screen and the error says nothing was estimated.
The service status is shown in the top bar; **Run live analysis** is enabled only once the API answers.

To run your own analysis:

1. Enter one row per holding: a symbol and an **initial weight in percent**. Use **Add holding** and **×** to
   add and remove rows. There can be up to 20 holdings. The running total must reach 100%.
2. Choose start and end dates and enter the **annual risk-free rate in percent** (for example `3` for 3%).
3. Choose **Run live analysis**. The form starts with the example's inputs.
4. Errors appear next to the relevant field. When the problem is with the data for one symbol (no data,
   interior gaps, invalid prices), that symbol's row is highlighted. Changing any input after a live run marks
   that result as out of date, and a response for inputs that changed while the request was running is discarded.
5. **Saved portfolios**: enter a name and choose **Save in this browser**. The dashboard stores the inputs (not
   the results) in the browser's `localStorage`, so they are private to that browser: other visitors never see
   them, nothing is sent to the server, and they disappear if site data is cleared or in a private window. Saving
   under an existing name replaces it, and a browser holds at most 50. **Load** fills the form; **Delete** asks
   for confirmation. Saving works even while the API is asleep.

## Tests

```bash
pytest
node --test "tests/js/*.test.mjs"
```

The JavaScript tests cover the page's own calculations: date formatting, axis ticks, the histogram, and that daily
returns derived from the example reproduce the API's annualized volatility and drawdown dates.

The tests do not use the network. They use deterministic in-memory price fixtures, temporary SQLite databases,
and `app.dependency_overrides` for both the provider and the database session. One test replaces
`yfinance.download` with a canned response to check how `fetch_prices` normalizes it.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Liveness check |
| GET | `/api/v1/prices/{symbol}?start_date=&end_date=` | Observed adjusted closes. `end_date` defaults to today; `start_date` defaults to 365 days before it |
| POST | `/api/v1/analyze` | Portfolio metrics and chart series |
| POST | `/api/v1/portfolios` | Save a configuration (201). The four `/portfolios` endpoints share one list for all callers and answer `404 NOT_ENABLED` when `SAVED_PORTFOLIOS_ENABLED=false` |
| GET | `/api/v1/portfolios` | List saved configurations, newest first |
| GET | `/api/v1/portfolios/{id}` | Load one configuration |
| DELETE | `/api/v1/portfolios/{id}` | Delete one configuration (204) |

Rates are decimals throughout the API: `0.21` means 21%.

### Examples

```bash
curl -s -X POST http://127.0.0.1:8000/api/v1/analyze \
  -H 'Content-Type: application/json' \
  -d '{
        "holdings": [
          {"symbol": "AAPL", "weight": 0.5},
          {"symbol": "MSFT", "weight": 0.3},
          {"symbol": "GOOG", "weight": 0.2}
        ],
        "start_date": "2024-01-01",
        "end_date": "2025-12-31",
        "risk_free_rate": 0.03
      }'
```

The response includes:

- `start_date` / `end_date`: the effective window
- `observations`: the number of daily *return* observations
- `metrics`: any metric may be `null`
- `portfolio_value`, `drawdown`: `dates` and `values` arrays of equal length
- `normalized_assets`: one series per symbol
- `correlation`: `symbols` and `matrix`; entries may be `null`
- `warnings`
- `prices_fetched_at`: when the oldest price series used was downloaded (UTC); cached prices can be up to
  `CACHE_TTL_HOURS` old

```bash
curl -s "http://127.0.0.1:8000/api/v1/prices/MSFT?start_date=2025-12-01&end_date=2025-12-31"

curl -s -X POST http://127.0.0.1:8000/api/v1/portfolios \
  -H 'Content-Type: application/json' \
  -d '{"name": "Big Tech", "holdings": [{"symbol": "AAPL", "weight": 0.6}, {"symbol": "MSFT", "weight": 0.4}],
       "start_date": "2024-01-01", "end_date": "2025-12-31", "risk_free_rate": 0.03}'

curl -s http://127.0.0.1:8000/api/v1/portfolios
curl -s -X DELETE http://127.0.0.1:8000/api/v1/portfolios/1
```

### Errors

Every error uses the same envelope:

```json
{
  "error": {
    "code": "NO_DATA",
    "message": "No price data returned for XYZ. The symbol may be invalid, delisted, or unavailable for this range. A provider outage or rate limit is also possible.",
    "details": {"symbols": ["XYZ"]}
  }
}
```

A validation failure lists each field location with a readable message:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "details": {"errors": [
      {"field": "holdings", "message": "Duplicate symbols: AAPL."},
      {"field": "end_date", "message": "start_date must be before end_date."}
    ]}
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Invalid request. Checked before any market data is requested |
| `NO_DATA` | 422 | No usable prices for one or more symbols (`details.symbols`) |
| `MISSING_DATA` | 422 | Interior gaps across assets (`details.symbols`, up to five `details.dates`) |
| `INSUFFICIENT_DATA` | 422 | Fewer than 20 return observations (`details.observations`) |
| `PROVIDER_ERROR` | 502 | Identifiable upstream failure, invalid observed prices, or an unusable response |
| `NOT_FOUND` | 404 | Unknown saved portfolio |
| `NOT_ENABLED` | 404 | Server-side saved portfolios are turned off (`SAVED_PORTFOLIOS_ENABLED=false`) |
| `INTERNAL_ERROR` | 500 | Unexpected failure. The server logs it; the client never sees tracebacks or raw provider/SQL messages |

## Input rules

- Symbols are trimmed, uppercased, and must match `^[A-Z][A-Z0-9.\-]{0,9}$`.
- A portfolio has 1–20 holdings. Duplicate symbols (after normalization) are rejected.
- Weights must be finite and nonnegative, no single weight may exceed 1.0 (plus the tolerance), and the
  weights must total 1.0 within an absolute tolerance of 1e-6. After
  validation they are divided by their total so the calculation uses weights that sum exactly to 1.0.
- `start_date` must be before `end_date`. Neither date may be after today, and the range may not exceed 20
  calendar years.
- `risk_free_rate` must be finite and between 0.0 and 0.20.
- Saved portfolio names are trimmed and must be 1–100 characters.

## Financial assumptions and formulas

- Long-only US equities in USD, using daily **adjusted** closing prices. Splits and dividends are reflected in
  the provider's adjustment.
- Weights are the **initial** allocation of a buy-and-hold portfolio. The portfolio value starts at 1.0.
- 252 trading days per year. Sample standard deviations (`ddof=1`). Correlations are Pearson correlations of
  daily percentage returns.
- Missing prices are never replaced with zero, forward-filled, or interpolated.
- No transaction costs, taxes, or cash flows are modeled.

With `n` = the number of portfolio return observations:

```
normalized_prices     = prices / prices.iloc[0]
portfolio_value       = normalized_prices.mul(weights).sum(axis=1)      # weights aligned by symbol
portfolio_returns     = portfolio_value.pct_change(fill_method=None).dropna()

total_return          = portfolio_value.iloc[-1] / portfolio_value.iloc[0] - 1
annualized_return     = (1 + total_return) ** (252 / n) - 1
annualized_volatility = portfolio_returns.std(ddof=1) * sqrt(252)

drawdown              = portfolio_value / portfolio_value.cummax() - 1
max_drawdown          = drawdown.min()

daily_rf              = (1 + risk_free_rate) ** (1 / 252) - 1
excess_returns        = portfolio_returns - daily_rf
sharpe_ratio          = excess_returns.mean() / excess_returns.std(ddof=1) * sqrt(252)
```

If the standard deviation of excess returns is below 1e-12, the Sharpe ratio is `null` and a warning explains
why. Zero volatility is still reported as `0`. Other undefined values are returned as `null`, never as NaN or
infinity.

### Buy-and-hold vs. daily rebalancing

Multiplying each day's asset returns by constant weights assumes the portfolio is rebalanced back to those
weights every day. This app does not do that. It holds the initial shares, so weights drift with prices.

Example: asset A moves 100 → 200 → 100 and asset B stays at 100, with 50/50 initial weights.

- **Buy-and-hold:** the value goes 1.0 → 1.5 → 1.0.
- **Daily rebalancing:** the value goes 1.0 → 1.5 → 1.125, because it sells A after the rise and buys more
  before the fall.

A test pins the buy-and-hold result.

### Common window and interior gaps

- **Common window:** the analysis runs from the latest first observation to the earliest last observation
  across the symbols. If there is no overlap, the result is `INSUFFICIENT_DATA` with zero observations. If
  either end moves more than five calendar days from the requested range, a warning names the symbols
  responsible (for example, a recent IPO).
- **Interior gaps:** inside the window, every asset must have a price on every date on which any asset has one.
  Otherwise the result is `MISSING_DATA`. Those dates are not dropped, because dropping them would turn a
  multi-day move into a single "daily" return. Ordinary weekends and holidays need no special handling because
  no asset trades on them.
- **Minimum length:** an analysis needs at least 20 return observations. The raw prices endpoint has no
  minimum.
- **Constant prices:** an asset whose price never changes produces a warning, and its correlations are `null`.

### What cannot be detected

There is no trading calendar, so a date that is missing for **every** asset is indistinguishable from a market
holiday. The adjacent observations are then treated as consecutive, and their change counts as one daily
return. This matters most for **single-asset** analysis, where there is no second series to reveal a gap at
all.

## Caching

Prices are stored in the `prices` table with `symbol`, `date`, `adjusted_close`, `source` and `fetched_at`,
unique on `(symbol, date, source)`. The `price_fetches` table records the date range of each symbol's cached
fetch. For each requested symbol, the cached rows in the range are used only if that symbol's recorded fetch
covers the whole requested range and was made within `CACHE_TTL_HOURS` (default 24).

Recording coverage separately means dates without rows (weekends, holidays, or days before a stock was listed)
are known to be gaps rather than missing cache entries.

Otherwise the symbol's **entire** requested range is fetched again:

1. The fresh data is validated first. A zero, negative, or infinite observed price is a `PROVIDER_ERROR` and is
   never turned into a missing value.
2. The fresh data is used for the current analysis.
3. In one transaction, **all** cached rows for that symbol and source are deleted and the fresh range and its
   coverage record are inserted.

A failed fetch, invalid prices, or an empty result leaves the existing cache untouched and returns an error.
The app never silently falls back to stale data. Stale symbols in one request are fetched in a single provider
call, and no-data outcomes are collected across all of them before `NO_DATA` is returned.

Deliberate tradeoffs:

- **Replacing the whole symbol history** throws away some reusable rows. In exchange, a series never mixes
  prices from separate fetches that may have been adjusted differently. Adjusted closes change retroactively
  after every dividend or split.
- **Only one range is cached per symbol.** Requesting a range outside the cached one refetches and replaces it.
  The data-quality rules above apply to cached and fresh data alike.
- There is no background refresh. A cached series older than the TTL is refreshed on the next request that
  needs it.

## Provider limitations

- **Rate limits and availability.** Yahoo Finance is an unofficial, unauthenticated source that can throttle
  requests or be unavailable.
- **Ambiguous empty responses.** `yfinance.download` catches most per-symbol network, timeout and rate-limit
  failures and returns an empty column instead of raising. An empty response therefore cannot be told apart
  from an invalid, delisted or unlisted symbol. The app reports these as `NO_DATA` and says the symbol *may* be
  invalid, delisted or unavailable. When every requested symbol comes back empty, the message also mentions a
  possible outage or rate limit. `PROVIDER_ERROR` is used only when the failure is identifiable: an exception
  from the provider call, an unusable response structure, or invalid observed prices.
- **Retroactive adjustments.** Adjusted closes are recomputed by the provider after corporate actions, so the
  same historical date can have different values in different fetches. This is why a refresh replaces a
  symbol's whole cached history.
- **Timeout.** `PROVIDER_TIMEOUT_SECONDS` is passed to yfinance.

## Limits of historical metrics

- Every metric describes one historical sample and is sensitive to the chosen start and end dates. A single
  crash or rally near an endpoint can dominate the result. Past performance does not predict future returns.
- Annualized return compounds the sample's total return over `252 / n`. Over short windows this extrapolates
  wildly.
- Annualized volatility and Sharpe scale daily figures by √252. That assumes daily returns are independent and
  identically distributed. Real returns show volatility clustering, autocorrelation and fat tails, so the
  square-root-of-time rule is only an approximation.
- The Sharpe ratio treats volatility as the only risk and uses a constant risk-free rate for the whole period.
- Correlations are estimated over the whole window and can change sharply across market regimes, often rising
  in stress periods.

## Possible future improvements

- An exchange trading calendar, to detect dates missing from every asset.
- Periodic-rebalancing strategies alongside buy-and-hold.
- Benchmark comparison (for example against SPY), with beta and tracking error.
- Rolling-window volatility and correlation charts.
- Additional risk measures such as Sortino ratio, value at risk, and expected shortfall.
- Updating saved portfolios in place.

## License

MIT. See [LICENSE](LICENSE).
