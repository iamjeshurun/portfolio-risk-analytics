import json
from datetime import UTC, date, datetime, timedelta

import pandas as pd
from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import analytics
from app.database import Portfolio, get_db
from app.errors import AppError, validation_error
from app.market_data import BOUNDARY_TOLERANCE_DAYS, PRICE_SOURCE, PriceFetcher, get_price_fetcher, get_prices
from app.schemas import (
    AnalysisRequest,
    AnalysisResponse,
    ErrorResponse,
    Health,
    PortfolioCreate,
    PortfolioOut,
    PriceHistory,
    check_date_range,
    normalize_symbol,
)

MIN_OBSERVATIONS = 20

ERRORS = {
    422: {"model": ErrorResponse, "description": "Validation or data error"},
    502: {"model": ErrorResponse, "description": "Market data provider error"},
}

router = APIRouter(prefix="/api/v1")


def finite_or_none(value) -> float | None:
    """Python float for JSON, or None for NaN/infinity."""
    if value is None or pd.isna(value):
        return None
    value = float(value)
    return value if abs(value) != float("inf") else None


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


@router.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok")


@router.get("/prices/{symbol}", response_model=PriceHistory, responses=ERRORS)
def price_history(
    symbol: str,
    start_date: date | None = None,
    end_date: date | None = None,
    db: Session = Depends(get_db),
    fetch: PriceFetcher = Depends(get_price_fetcher),
) -> PriceHistory:
    """Observed adjusted closing prices. Defaults to the 365 days ending today."""
    try:
        symbol = normalize_symbol(symbol)
    except ValueError as exc:
        raise validation_error("symbol", str(exc))
    end = end_date or date.today()
    start = start_date or end - timedelta(days=365)
    try:
        check_date_range(start, end)
    except ValueError as exc:
        raise validation_error("end_date", str(exc))

    series = get_prices(db, [symbol], start, end, fetch)[symbol].dropna()
    return PriceHistory(
        symbol=symbol,
        source=PRICE_SOURCE,
        start_date=start,
        end_date=end,
        prices=[{"date": timestamp.date(), "adjusted_close": float(price)} for timestamp, price in series.items()],
    )


@router.post("/analyze", response_model=AnalysisResponse, responses=ERRORS)
def analyze(
    request: AnalysisRequest,
    db: Session = Depends(get_db),
    fetch: PriceFetcher = Depends(get_price_fetcher),
) -> AnalysisResponse:
    """Buy-and-hold performance and risk metrics for the given initial weights."""
    symbols = [holding.symbol for holding in request.holdings]
    weights = pd.Series({holding.symbol: holding.weight for holding in request.holdings}, dtype=float)
    weights = weights / weights.sum()
    prices = get_prices(db, symbols, request.start_date, request.end_date, fetch)
    return analyze_prices(prices, weights, request.risk_free_rate, request.start_date, request.end_date)


def portfolio_out(portfolio: Portfolio) -> PortfolioOut:
    return PortfolioOut(
        id=portfolio.id,
        name=portfolio.name,
        holdings=json.loads(portfolio.holdings),
        start_date=portfolio.start_date,
        end_date=portfolio.end_date,
        risk_free_rate=portfolio.risk_free_rate,
        created_at=portfolio.created_at,
    )


def find_portfolio(db: Session, portfolio_id: int) -> Portfolio:
    portfolio = db.get(Portfolio, portfolio_id)
    if portfolio is None:
        raise AppError("NOT_FOUND", f"Saved portfolio {portfolio_id} was not found.", 404)
    return portfolio


@router.post("/portfolios", response_model=PortfolioOut, status_code=201, responses={422: ERRORS[422]})
def create_portfolio(request: PortfolioCreate, db: Session = Depends(get_db)) -> PortfolioOut:
    """Save analysis inputs (not results). Does not fetch market data."""
    portfolio = Portfolio(
        name=request.name,
        holdings=json.dumps([holding.model_dump() for holding in request.holdings]),
        start_date=request.start_date,
        end_date=request.end_date,
        risk_free_rate=request.risk_free_rate,
        created_at=datetime.now(UTC).replace(tzinfo=None),
    )
    db.add(portfolio)
    db.commit()
    db.refresh(portfolio)
    return portfolio_out(portfolio)


@router.get("/portfolios", response_model=list[PortfolioOut])
def list_portfolios(db: Session = Depends(get_db)) -> list[PortfolioOut]:
    portfolios = db.scalars(select(Portfolio).order_by(Portfolio.created_at.desc(), Portfolio.id.desc()))
    return [portfolio_out(portfolio) for portfolio in portfolios]


@router.get("/portfolios/{portfolio_id}", response_model=PortfolioOut, responses={404: {"model": ErrorResponse}, 422: ERRORS[422]})
def get_portfolio(portfolio_id: int, db: Session = Depends(get_db)) -> PortfolioOut:
    return portfolio_out(find_portfolio(db, portfolio_id))


@router.delete("/portfolios/{portfolio_id}", status_code=204, responses={404: {"model": ErrorResponse}, 422: ERRORS[422]})
def delete_portfolio(portfolio_id: int, db: Session = Depends(get_db)) -> Response:
    db.delete(find_portfolio(db, portfolio_id))
    db.commit()
    return Response(status_code=204)
