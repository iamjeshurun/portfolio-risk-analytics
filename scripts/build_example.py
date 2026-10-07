"""Precompute the example portfolio analysis shown on the dashboard's first load.

Fetches adjusted daily closes from Yahoo Finance (via yfinance) and runs the
same analysis code the API uses, then writes app/static/example-analysis.json
with the inputs, the data source, and when the prices were fetched. Nothing in
the output is hand-written.

    python scripts/build_example.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.analysis import analyze_prices  # noqa: E402
from app.market_data import PRICE_SOURCE, fetch_prices  # noqa: E402

OUTPUT = ROOT / "app" / "static" / "example-analysis.json"
EXAMPLE = {
    "holdings": [
        {"symbol": "AAPL", "weight": 0.40},
        {"symbol": "MSFT", "weight": 0.35},
        {"symbol": "GOOG", "weight": 0.25},
    ],
    "start_date": "2023-01-01",
    "end_date": "2025-12-31",
    "risk_free_rate": 0.04,
}


def main() -> None:
    symbols = [holding["symbol"] for holding in EXAMPLE["holdings"]]
    start, end = date.fromisoformat(EXAMPLE["start_date"]), date.fromisoformat(EXAMPLE["end_date"])
    fetched_at = datetime.now(UTC).replace(microsecond=0)
    prices = fetch_prices(symbols, start, end)
    weights = pd.Series({h["symbol"]: h["weight"] for h in EXAMPLE["holdings"]}, dtype=float)
    result = analyze_prices(prices, weights / weights.sum(), EXAMPLE["risk_free_rate"], start, end)
    payload = {
        "kind": "example",
        "inputs": EXAMPLE,
        "source": {
            "provider": PRICE_SOURCE,
            "description": "Adjusted daily closes from Yahoo Finance, fetched with yfinance",
            "fetched_at": fetched_at.isoformat().replace("+00:00", "Z"),
        },
        "analysis": json.loads(result.model_dump_json()),
    }
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    metrics = result.metrics
    print(
        f"Wrote {OUTPUT.relative_to(ROOT)}: {result.observations} observations, "
        f"total return {metrics.total_return:.4f}, max drawdown {metrics.max_drawdown:.4f}, Sharpe {metrics.sharpe_ratio:.3f}"
    )


if __name__ == "__main__":
    main()
