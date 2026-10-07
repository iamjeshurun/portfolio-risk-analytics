"""Historical price retrieval (yfinance) and the SQLite price cache."""

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import CACHE_TTL_HOURS, PROVIDER_TIMEOUT_SECONDS
from app.database import Price, PriceFetch
from app.errors import AppError

logger = logging.getLogger(__name__)

PRICE_SOURCE = "yfinance"
BOUNDARY_TOLERANCE_DAYS = 5  # weekend/holiday slack for analysis-window warnings

PriceFetcher = Callable[[list[str], date, date], pd.DataFrame]


def provider_error(message: str, symbols: list[str] | None = None) -> AppError:
    details = {"symbols": symbols} if symbols else None
    return AppError("PROVIDER_ERROR", message, 502, details)


def fetch_prices(symbols: list[str], start: date, end: date) -> pd.DataFrame:
    """Download adjusted daily closes from Yahoo Finance. The end date is inclusive."""
    try:
        raw = yf.download(
            symbols,
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),  # yfinance's end is exclusive
            auto_adjust=True,
            progress=False,
            timeout=PROVIDER_TIMEOUT_SECONDS,
        )
    except Exception:
        logger.exception("yfinance download failed for %s", symbols)
        raise provider_error("The market data provider request failed. Please try again later.")

    if raw is None or (isinstance(raw, pd.DataFrame) and raw.empty):
        return empty_price_frame(symbols)
    if not isinstance(raw, pd.DataFrame):
        logger.error("Unexpected yfinance response type: %s", type(raw))
        raise provider_error("The market data provider returned an unusable response.")

    # auto_adjust=True means "Close" is already the adjusted close.
    if isinstance(raw.columns, pd.MultiIndex):
        if "Close" not in raw.columns.get_level_values(0):
            logger.error("yfinance response has no Close column: %s", list(raw.columns))
            raise provider_error("The market data provider returned an unusable response.")
        closes = raw["Close"]
    elif "Close" in raw.columns and len(symbols) == 1:
        closes = raw[["Close"]].rename(columns={"Close": symbols[0]})
    else:
        logger.error("yfinance response has unexpected columns: %s", list(raw.columns))
        raise provider_error("The market data provider returned an unusable response.")

    return normalize_price_frame(closes, symbols)


def empty_price_frame(symbols: list[str]) -> pd.DataFrame:
    return pd.DataFrame(columns=symbols, index=pd.DatetimeIndex([], name="date"), dtype=float)


def normalize_price_frame(closes: pd.DataFrame, symbols: list[str]) -> pd.DataFrame:
    """Sorted, unique, tz-naive daily dates; exactly the requested symbol columns; NaN kept."""
    try:
        frame = closes.astype(float)
    except (TypeError, ValueError):
        logger.error("yfinance returned non-numeric prices")
        raise provider_error("The market data provider returned an unusable response.")
    index = pd.DatetimeIndex(frame.index)
    if index.tz is not None:
        index = index.tz_localize(None)
    frame.index = index.normalize().rename("date")
    frame = frame[~frame.index.duplicated(keep="first")].sort_index()
    frame.columns = [str(column).upper() for column in frame.columns]
    return frame.reindex(columns=symbols)


def invalid_price_symbols(prices: pd.DataFrame) -> list[str]:
    """Symbols with observed prices that are infinite, zero, or negative. NaN is missing, not invalid."""
    values = prices.to_numpy(dtype=float)
    invalid = ~np.isnan(values) & (np.isinf(values) | (values <= 0))
    return [symbol for symbol, bad in zip(prices.columns, invalid.any(axis=0)) if bad]


def no_data_error(symbols: list[str], all_requested_missing: bool) -> AppError:
    message = (
        f"No price data returned for {', '.join(symbols)}. "
        "The symbol may be invalid, delisted, or unavailable for this range."
    )
    if all_requested_missing:
        message += " A provider outage or rate limit is also possible."
    return AppError("NO_DATA", message, 422, {"symbols": symbols})


def read_cached_prices(db: Session, symbol: str, start: date, end: date) -> list[Price]:
    query = (
        select(Price)
        .where(Price.symbol == symbol, Price.source == PRICE_SOURCE, Price.date >= start, Price.date <= end)
        .order_by(Price.date)
    )
    return list(db.scalars(query))


def cache_covers(db: Session, symbol: str, start: date, end: date, now: datetime) -> bool:
    """True when a fresh fetch spanning the whole range is recorded for the symbol.

    Coverage is tracked separately from the price rows, so a symbol whose history
    begins after `start` (or that skips holidays) is still served from cache.
    """
    query = select(PriceFetch.id).where(
        PriceFetch.symbol == symbol,
        PriceFetch.source == PRICE_SOURCE,
        PriceFetch.start_date <= start,
        PriceFetch.end_date >= end,
        PriceFetch.fetched_at >= now - timedelta(hours=CACHE_TTL_HOURS),
    )
    return db.scalars(query.limit(1)).first() is not None


def replace_cached_prices(
    db: Session, symbol: str, prices: pd.Series, start: date, end: date, fetched_at: datetime
) -> None:
    """Atomically replace the symbol's whole cached history with one fresh fetch.

    Adjusted closes change retroactively after dividends and splits, so rows from
    separate fetches are never mixed.
    """
    try:
        db.execute(delete(Price).where(Price.symbol == symbol, Price.source == PRICE_SOURCE))
        db.execute(delete(PriceFetch).where(PriceFetch.symbol == symbol, PriceFetch.source == PRICE_SOURCE))
        db.add(PriceFetch(symbol=symbol, source=PRICE_SOURCE, start_date=start, end_date=end, fetched_at=fetched_at))
        db.add_all(
            Price(
                symbol=symbol,
                date=timestamp.date(),
                adjusted_close=float(value),
                source=PRICE_SOURCE,
                fetched_at=fetched_at,
            )
            for timestamp, value in prices.dropna().items()
        )
        db.commit()
    except Exception:
        db.rollback()
        raise


def get_prices(db: Session, symbols: list[str], start: date, end: date, fetch: PriceFetcher) -> pd.DataFrame:
    """Observed adjusted closes for each symbol, from cache when sufficient, otherwise freshly fetched.

    Returns a DataFrame over the union of observed dates; NaN where a symbol has no observation.
    """
    now = datetime.now(UTC).replace(tzinfo=None)
    series: dict[str, pd.Series] = {}
    stale: list[str] = []
    missing: list[str] = []
    for symbol in symbols:
        if cache_covers(db, symbol, start, end, now):
            rows = read_cached_prices(db, symbol, start, end)
            if not rows:  # fetched recently and the provider had nothing in this range
                missing.append(symbol)
                continue
            index = pd.DatetimeIndex([row.date for row in rows], name="date")
            series[symbol] = pd.Series([row.adjusted_close for row in rows], index=index, dtype=float)
        else:
            stale.append(symbol)

    if stale:
        fresh = fetch(stale, start, end).reindex(columns=stale)
        fresh.index = pd.DatetimeIndex(fresh.index)
        invalid = invalid_price_symbols(fresh)
        if invalid:
            raise provider_error(
                f"The market data provider returned invalid prices (zero, negative, or infinite) for {', '.join(invalid)}.",
                invalid,
            )
        for symbol in stale:
            observed = fresh[symbol].dropna()
            observed = observed[(observed.index >= pd.Timestamp(start)) & (observed.index <= pd.Timestamp(end))]
            if observed.empty:
                missing.append(symbol)
                continue
            replace_cached_prices(db, symbol, observed, start, end, now)
            series[symbol] = observed

    if missing:
        missing = [symbol for symbol in symbols if symbol in missing]
        raise no_data_error(missing, all_requested_missing=len(missing) == len(symbols))

    return pd.concat([series[symbol].rename(symbol) for symbol in symbols], axis=1).sort_index()


def get_price_fetcher() -> PriceFetcher:
    """FastAPI dependency; tests replace it through app.dependency_overrides."""
    return fetch_prices
