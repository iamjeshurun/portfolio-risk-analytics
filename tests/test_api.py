from datetime import date

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.database import get_db, init_db, make_engine
from app.errors import AppError
from app.main import app
from app.market_data import get_price_fetcher

PATH = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 114, 108, 102, 96, 90, 94, 98, 102, 106, 110]
DATES = pd.bdate_range("2024-01-01", periods=len(PATH))  # 2024-01-01 .. 2024-01-29

VALID_REQUEST = {
    "holdings": [{"symbol": "AAA", "weight": 0.6}, {"symbol": "BBB", "weight": 0.4}],
    "start_date": "2024-01-01",
    "end_date": "2024-01-29",
    "risk_free_rate": 0.03,
}


class FakeProvider:
    def __init__(self, prices=None, error=None):
        self.prices = prices if prices is not None else {}
        self.error = error
        self.calls = 0

    def __call__(self, symbols, start, end):
        self.calls += 1
        if self.error:
            raise self.error
        return pd.DataFrame({s: self.prices.get(s, pd.Series(dtype=float)) for s in symbols}, dtype=float)


@pytest.fixture
def client(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")
    init_db(engine)
    Session = sessionmaker(bind=engine)

    def override_db():
        with Session() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    engine.dispose()


def use_provider(provider):
    app.dependency_overrides[get_price_fetcher] = lambda: provider
    return provider


def with_request(**changes):
    return {**VALID_REQUEST, **changes}


@pytest.mark.parametrize(
    "body",
    [
        with_request(holdings=[{"symbol": "AAA", "weight": 0.6}, {"symbol": "BBB", "weight": 0.3}]),
        with_request(holdings=[{"symbol": "AAA", "weight": 1.2}, {"symbol": "BBB", "weight": -0.2}]),
        with_request(holdings=[{"symbol": "AAA", "weight": 0.5}, {"symbol": " aaa ", "weight": 0.5}]),
        with_request(holdings=[{"symbol": "1BAD", "weight": 1.0}]),
        with_request(start_date="2024-01-29", end_date="2024-01-01"),
        with_request(holdings=[{"symbol": "AAA", "weight": 1e308}, {"symbol": "BBB", "weight": 1e308}]),
    ],
    ids=["weights-not-100", "negative-weight", "duplicate-symbol", "malformed-symbol", "reversed-dates", "oversized-weights"],
)
def test_invalid_analysis_input_is_rejected_before_fetching(client, body):
    provider = use_provider(FakeProvider())
    response = client.post("/api/v1/analyze", json=body)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert error["details"]["errors"][0]["message"]
    assert provider.calls == 0


def test_successful_analysis(client):
    path = pd.Series(PATH, index=DATES, dtype=float)
    use_provider(FakeProvider({"AAA": path, "BBB": path}))
    response = client.post("/api/v1/analyze", json=VALID_REQUEST)
    assert response.status_code == 200
    body = response.json()

    assert body["observations"] == 20
    assert (body["start_date"], body["end_date"]) == ("2024-01-01", "2024-01-29")
    metrics = body["metrics"]
    assert metrics["total_return"] == pytest.approx(0.10)
    assert metrics["max_drawdown"] == pytest.approx(-0.25)
    for key in ("annualized_return", "annualized_volatility", "sharpe_ratio"):
        assert isinstance(metrics[key], float)
    for key in ("portfolio_value", "drawdown"):
        assert len(body[key]["dates"]) == len(body[key]["values"]) == 21
    assert all(len(values) == 21 for values in body["normalized_assets"]["series"].values())
    assert body["correlation"]["symbols"] == ["AAA", "BBB"]
    assert body["correlation"]["matrix"][0][1] == pytest.approx(1.0)
    assert body["warnings"] == []


def test_provider_failure_hides_internal_details(client):
    use_provider(FakeProvider(error=AppError("PROVIDER_ERROR", "The market data provider request failed.", 502)))
    response = client.post("/api/v1/analyze", json=VALID_REQUEST)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PROVIDER_ERROR"
    assert "Traceback" not in response.text


def test_interior_gap_returns_missing_data(client):
    path = pd.Series(PATH, index=DATES, dtype=float)
    use_provider(FakeProvider({"AAA": path, "BBB": path.drop(DATES[5])}))
    response = client.post("/api/v1/analyze", json=VALID_REQUEST)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "MISSING_DATA"
    assert error["details"] == {"symbols": ["BBB"], "dates": [DATES[5].date().isoformat()]}


def test_no_data_names_every_empty_symbol_and_mentions_outage(client):
    use_provider(FakeProvider({}))
    response = client.post("/api/v1/analyze", json=VALID_REQUEST)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "NO_DATA"
    assert error["details"]["symbols"] == ["AAA", "BBB"]
    assert "rate limit" in error["message"]


def test_saved_portfolio_lifecycle_does_not_fetch_prices(client):
    provider = use_provider(FakeProvider())
    created = client.post("/api/v1/portfolios", json={**VALID_REQUEST, "name": "  Core  "})
    assert created.status_code == 201
    saved = created.json()
    assert saved["name"] == "Core"

    assert [p["id"] for p in client.get("/api/v1/portfolios").json()] == [saved["id"]]
    loaded = client.get(f"/api/v1/portfolios/{saved['id']}").json()
    assert loaded["holdings"] == VALID_REQUEST["holdings"]

    assert client.delete(f"/api/v1/portfolios/{saved['id']}").status_code == 204
    missing = client.get(f"/api/v1/portfolios/{saved['id']}")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "NOT_FOUND"
    assert provider.calls == 0


def test_yfinance_response_is_normalized(monkeypatch):
    from app import market_data

    captured = {}
    columns = pd.MultiIndex.from_tuples([("Close", "AAA"), ("Open", "AAA")], names=["Price", "Ticker"])
    index = pd.DatetimeIndex(["2024-01-03", "2024-01-02", "2024-01-02"])
    raw = pd.DataFrame([[11.0, 1.0], [10.0, 1.0], [10.0, 1.0]], index=index, columns=columns)

    def fake_download(symbols, **kwargs):
        captured.update(kwargs)
        return raw

    monkeypatch.setattr(market_data.yf, "download", fake_download)
    prices = market_data.fetch_prices(["AAA", "BBB"], date(2024, 1, 2), date(2024, 1, 3))

    assert captured["end"] == "2024-01-04" and captured["auto_adjust"] is True
    assert list(prices.columns) == ["AAA", "BBB"]
    assert prices["AAA"].tolist() == [10.0, 11.0]
    assert prices["BBB"].isna().all()
