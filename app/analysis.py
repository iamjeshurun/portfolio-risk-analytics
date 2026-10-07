"""Data-quality rules and response assembly for a portfolio analysis."""

import math
from datetime import date, timedelta

import pandas as pd

from app import analytics
from app.errors import AppError
from app.market_data import BOUNDARY_TOLERANCE_DAYS
from app.schemas import AnalysisResponse

MIN_OBSERVATIONS = 20


def finite_or_none(value) -> float | None:
    """Python float for JSON, or None for NaN/infinity."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def float_list(values) -> list[float | None]:
    return [finite_or_none(value) for value in values]


def date_list(index: pd.Index) -> list[date]:
    return [timestamp.date() for timestamp in index]


def analyze_prices(
    prices: pd.DataFrame, weights: pd.Series, risk_free_rate: float, start: date, end: date
) -> AnalysisResponse:
    """Apply the data-quality rules, then compute metrics and chart series."""
    warnings: list[str] = []
    symbols = list(prices.columns)

    # Common window: latest first observation through earliest last observation.
    firsts = {symbol: prices[symbol].first_valid_index() for symbol in symbols}
    lasts = {symbol: prices[symbol].last_valid_index() for symbol in symbols}
    window_start, window_end = max(firsts.values()), min(lasts.values())
    if window_start > window_end:
        raise AppError(
            "INSUFFICIENT_DATA",
            "The assets have no overlapping date range with prices for every symbol.",
            422,
            {"observations": 0},
        )
    tolerance = timedelta(days=BOUNDARY_TOLERANCE_DAYS)
    if window_start.date() - start > tolerance:
        limiting = [symbol for symbol in symbols if firsts[symbol] == window_start]
        warnings.append(
            f"Analysis starts on {window_start.date()} instead of {start} because price history for "
            f"{', '.join(limiting)} begins later."
        )
    if end - window_end.date() > tolerance:
        limiting = [symbol for symbol in symbols if lasts[symbol] == window_end]
        warnings.append(
            f"Analysis ends on {window_end.date()} instead of {end} because price history for "
            f"{', '.join(limiting)} ends earlier."
        )

    window = prices.loc[window_start:window_end]

    # Interior gaps: every asset must have a price on every date any asset was observed.
    gaps = window.isna()
    if gaps.to_numpy().any():
        gap_symbols = [symbol for symbol in symbols if gaps[symbol].any()]
        gap_dates = [timestamp.date().isoformat() for timestamp in window.index[gaps.any(axis=1)][:5]]
        raise AppError(
            "MISSING_DATA",
            f"Prices for {', '.join(gap_symbols)} are missing on dates where other holdings have prices. "
            "Try a different date range or remove the affected symbols.",
            422,
            {"symbols": gap_symbols, "dates": gap_dates},
        )

    observations = len(window) - 1
    if observations < MIN_OBSERVATIONS:
        raise AppError(
            "INSUFFICIENT_DATA",
            f"Only {observations} daily return observations are available; at least {MIN_OBSERVATIONS} are required.",
            422,
            {"observations": observations},
        )

    constant = [symbol for symbol in symbols if window[symbol].nunique() == 1]
    if constant:
        warnings.append(
            f"Prices for {', '.join(constant)} did not change during the period, so their correlations are undefined."
        )

    value = analytics.portfolio_value(window, weights)
    returns = analytics.portfolio_returns(value)
    total = analytics.total_return(value)
    sharpe = analytics.sharpe_ratio(returns, risk_free_rate)
    if sharpe is None:
        warnings.append("Sharpe ratio is undefined because excess returns show no variation.")
    correlation = analytics.correlation_matrix(analytics.asset_returns(window))
    normalized = analytics.normalized_prices(window)
    drawdown = analytics.drawdown(value)

    return AnalysisResponse(
        start_date=window_start.date(),
        end_date=window_end.date(),
        observations=observations,
        metrics={
            "total_return": finite_or_none(total),
            "annualized_return": finite_or_none(analytics.annualized_return(total, observations)),
            "annualized_volatility": finite_or_none(analytics.annualized_volatility(returns)),
            "max_drawdown": finite_or_none(analytics.max_drawdown(value)),
            "sharpe_ratio": finite_or_none(sharpe),
        },
        portfolio_value={"dates": date_list(value.index), "values": float_list(value)},
        drawdown={"dates": date_list(drawdown.index), "values": float_list(drawdown)},
        normalized_assets={
            "dates": date_list(normalized.index),
            "series": {symbol: float_list(normalized[symbol]) for symbol in symbols},
        },
        correlation={
            "symbols": symbols,
            "matrix": [float_list(correlation.loc[symbol, symbols]) for symbol in symbols],
        },
        warnings=warnings,
    )
