from datetime import UTC, date, datetime, timedelta

import pandas as pd
from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis import analyze_prices
from app import config
from app.database import Portfolio, PriceFetch, get_db
from app.errors import AppError, validation_error
from app.market_data import PRICE_SOURCE, PriceFetcher, get_price_fetcher, get_prices
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

ERRORS = {
    422: {"model": ErrorResponse, "description": "Validation or data error"},
    502: {"model": ErrorResponse, "description": "Market data provider error"},
}

router = APIRouter(prefix="/api/v1")


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
    result = analyze_prices(prices, weights, request.risk_free_rate, request.start_date, request.end_date)
    fetched = db.scalars(
        select(PriceFetch.fetched_at).where(PriceFetch.symbol.in_(symbols), PriceFetch.source == PRICE_SOURCE)
    ).all()
    if len(fetched) == len(symbols):
        result.prices_fetched_at = min(fetched).replace(tzinfo=UTC)
    return result


def require_saved_portfolios() -> None:
    if not config.SAVED_PORTFOLIOS_ENABLED:
        raise AppError(
            "NOT_ENABLED",
            "Saved portfolios are turned off on this server so that visitors never share them. "
            "The dashboard saves portfolios in your browser instead.",
            404,
        )


saved = [Depends(require_saved_portfolios)]


def portfolio_out(portfolio: Portfolio) -> PortfolioOut:
    return PortfolioOut(
        id=portfolio.id,
        name=portfolio.name,
        holdings=portfolio.holdings,
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


@router.post("/portfolios", response_model=PortfolioOut, status_code=201, responses={422: ERRORS[422]}, dependencies=saved)
def create_portfolio(request: PortfolioCreate, db: Session = Depends(get_db)) -> PortfolioOut:
    """Save analysis inputs (not results). Does not fetch market data."""
    portfolio = Portfolio(
        name=request.name,
        holdings=[holding.model_dump() for holding in request.holdings],
        start_date=request.start_date,
        end_date=request.end_date,
        risk_free_rate=request.risk_free_rate,
        created_at=datetime.now(UTC).replace(tzinfo=None),
    )
    db.add(portfolio)
    db.commit()
    db.refresh(portfolio)
    return portfolio_out(portfolio)


@router.get("/portfolios", response_model=list[PortfolioOut], dependencies=saved)
def list_portfolios(db: Session = Depends(get_db)) -> list[PortfolioOut]:
    portfolios = db.scalars(select(Portfolio).order_by(Portfolio.created_at.desc(), Portfolio.id.desc()))
    return [portfolio_out(portfolio) for portfolio in portfolios]


@router.get("/portfolios/{portfolio_id}", response_model=PortfolioOut, responses={404: {"model": ErrorResponse}, 422: ERRORS[422]}, dependencies=saved)
def get_portfolio(portfolio_id: int, db: Session = Depends(get_db)) -> PortfolioOut:
    return portfolio_out(find_portfolio(db, portfolio_id))


@router.delete("/portfolios/{portfolio_id}", status_code=204, responses={404: {"model": ErrorResponse}, 422: ERRORS[422]}, dependencies=saved)
def delete_portfolio(portfolio_id: int, db: Session = Depends(get_db)) -> Response:
    db.delete(find_portfolio(db, portfolio_id))
    db.commit()
    return Response(status_code=204)
