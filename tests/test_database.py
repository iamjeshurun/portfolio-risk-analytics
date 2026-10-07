from datetime import UTC, date, datetime, timedelta

import pandas as pd
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import Price, init_db, make_engine
from app.errors import AppError
from app.market_data import get_prices, replace_cached_prices

START, END = date(2024, 1, 1), date(2024, 1, 31)


@pytest.fixture
def db(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")
    init_db(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def closes(start, periods, first=100.0):
    return pd.Series([first + i for i in range(periods)], index=pd.bdate_range(start, periods=periods), dtype=float)


def cached_dates(db, symbol):
    return list(db.scalars(select(Price.date).where(Price.symbol == symbol).order_by(Price.date)))


def test_refresh_replaces_symbol_history_without_duplicates(db):
    now = datetime(2024, 2, 1)
    replace_cached_prices(db, "AAA", closes("2023-12-01", 10), date(2023, 12, 1), date(2023, 12, 14), now)
    replace_cached_prices(db, "AAA", closes("2023-12-01", 10), date(2023, 12, 1), date(2023, 12, 14), now)
    assert db.scalar(select(func.count()).select_from(Price)) == 10

    replace_cached_prices(db, "AAA", closes("2024-01-01", 5), date(2024, 1, 1), date(2024, 1, 5), now)
    assert cached_dates(db, "AAA") == [d.date() for d in pd.bdate_range("2024-01-01", periods=5)]


def test_symbol_listed_after_start_is_served_from_cache(db):
    listed = date(2024, 1, 15)
    replace_cached_prices(db, "NEW", closes(listed, 13), START, END, datetime.now(UTC).replace(tzinfo=None))

    def fail(symbols, start, end):
        raise AssertionError("provider should not be called")

    prices = get_prices(db, ["NEW"], START, END, fail)
    assert prices.index[0].date() == listed


def raise_provider_error(symbols, start, end):
    raise AppError("PROVIDER_ERROR", "failed", 502)


def return_invalid_prices(symbols, start, end):
    return pd.DataFrame({"AAA": [100.0, -1.0]}, index=pd.bdate_range("2024-01-01", periods=2))


def return_no_data(symbols, start, end):
    return pd.DataFrame({"AAA": [float("nan")] * 3}, index=pd.bdate_range("2024-01-01", periods=3))


@pytest.mark.parametrize("fetch", [raise_provider_error, return_invalid_prices, return_no_data])
def test_failed_refresh_leaves_cache_untouched(db, fetch):
    stale = datetime(2020, 1, 1)
    replace_cached_prices(db, "AAA", closes("2024-01-01", 23), START, END, stale)
    before = [(p.date, p.adjusted_close, p.fetched_at) for p in db.scalars(select(Price).order_by(Price.date))]

    with pytest.raises(AppError):
        get_prices(db, ["AAA"], START, END, fetch)

    db.expire_all()
    after = [(p.date, p.adjusted_close, p.fetched_at) for p in db.scalars(select(Price).order_by(Price.date))]
    assert after == before


def test_fresh_cache_is_used_without_calling_provider(db):
    an_hour_ago = datetime.now(UTC).replace(tzinfo=None) - timedelta(hours=1)
    replace_cached_prices(db, "AAA", closes("2024-01-01", 23), START, END, an_hour_ago)

    def fail(symbols, start, end):
        raise AssertionError("provider should not be called")

    prices = get_prices(db, ["AAA"], START, END, fail)
    assert len(prices) == 23
