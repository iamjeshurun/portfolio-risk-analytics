import math
import re
from datetime import date, datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

SYMBOL_PATTERN = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
MAX_HOLDINGS = 20
MAX_RANGE_YEARS = 20
WEIGHT_TOLERANCE = 1e-6


def normalize_symbol(value: str) -> str:
    symbol = value.strip().upper()
    if not symbol:
        raise ValueError("Enter a symbol.")
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise ValueError(
            f"'{value}' is not a valid symbol. Use 1-10 characters: a letter first, then letters, digits, '.' or '-'."
        )
    return symbol


def add_years(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # February 29 in a non-leap target year
        return day.replace(year=day.year + years, day=28)


def check_date_range(start: date, end: date) -> None:
    today = date.today()
    if start >= end:
        raise ValueError("start_date must be before end_date.")
    if end > today:
        raise ValueError("end_date cannot be after today.")
    if end > add_years(start, MAX_RANGE_YEARS):
        raise ValueError(f"The date range cannot exceed {MAX_RANGE_YEARS} calendar years.")


class Holding(BaseModel):
    symbol: str = Field(examples=["AAPL"])
    weight: float = Field(
        ge=0,
        le=1.0 + WEIGHT_TOLERANCE,  # also keeps the total from overflowing before it is checked
        allow_inf_nan=False,
        description="Initial allocation as a decimal (0.5 = 50%).",
    )

    @field_validator("symbol", mode="before")
    @classmethod
    def validate_symbol(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("Symbol must be a string.")
        return normalize_symbol(value)


class PortfolioInputs(BaseModel):
    holdings: Annotated[list[Holding], Field(min_length=1, max_length=MAX_HOLDINGS)]
    start_date: date
    end_date: date
    risk_free_rate: float = Field(
        ge=0.0, le=0.20, allow_inf_nan=False, description="Annual risk-free rate as a decimal (0.03 = 3%)."
    )

    @field_validator("holdings")
    @classmethod
    def validate_holdings(cls, holdings: list[Holding]) -> list[Holding]:
        symbols = [holding.symbol for holding in holdings]
        duplicates = sorted({symbol for symbol in symbols if symbols.count(symbol) > 1})
        if duplicates:
            raise ValueError(f"Duplicate symbols: {', '.join(duplicates)}.")
        total = math.fsum(holding.weight for holding in holdings)
        if abs(total - 1.0) > WEIGHT_TOLERANCE:
            raise ValueError(f"Weights must total 1.0 (100%); they total {total:.6g}.")
        return holdings

    @field_validator("end_date")
    @classmethod
    def validate_end_date(cls, end: date, info: ValidationInfo) -> date:
        start = info.data.get("start_date")
        if start is not None:
            check_date_range(start, end)
        return end

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "holdings": [
                        {"symbol": "AAPL", "weight": 0.5},
                        {"symbol": "MSFT", "weight": 0.3},
                        {"symbol": "GOOG", "weight": 0.2},
                    ],
                    "start_date": "2024-01-01",
                    "end_date": "2025-12-31",
                    "risk_free_rate": 0.03,
                }
            ]
        }
    )


class AnalysisRequest(PortfolioInputs):
    pass


class PortfolioCreate(PortfolioInputs):
    name: str = Field(description="1-100 characters after trimming.")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not 1 <= len(name) <= 100:
            raise ValueError("Name must be 1-100 characters after trimming.")
        return name

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "name": "Big Tech",
                    "holdings": [{"symbol": "AAPL", "weight": 0.6}, {"symbol": "MSFT", "weight": 0.4}],
                    "start_date": "2024-01-01",
                    "end_date": "2025-12-31",
                    "risk_free_rate": 0.03,
                }
            ]
        }
    )


class PortfolioOut(BaseModel):
    id: int
    name: str
    holdings: list[Holding]
    start_date: date
    end_date: date
    risk_free_rate: float
    created_at: datetime


class Metrics(BaseModel):
    total_return: float | None
    annualized_return: float | None
    annualized_volatility: float | None
    max_drawdown: float | None
    sharpe_ratio: float | None


class TimeSeries(BaseModel):
    dates: list[date]
    values: list[float | None]


class AssetSeries(BaseModel):
    dates: list[date]
    series: dict[str, list[float | None]]


class Correlation(BaseModel):
    symbols: list[str]
    matrix: list[list[float | None]]


class AnalysisResponse(BaseModel):
    start_date: date = Field(description="First date of the effective analysis window.")
    end_date: date = Field(description="Last date of the effective analysis window.")
    observations: int = Field(description="Number of daily portfolio return observations.")
    metrics: Metrics
    portfolio_value: TimeSeries
    drawdown: TimeSeries
    normalized_assets: AssetSeries
    correlation: Correlation
    warnings: list[str]
    prices_fetched_at: datetime | None = Field(
        default=None,
        description="When the oldest of the price series used was downloaded from the provider (UTC). "
        "Cached prices can be up to CACHE_TTL_HOURS old.",
    )


class PricePoint(BaseModel):
    date: date
    adjusted_close: float


class PriceHistory(BaseModel):
    symbol: str
    source: str
    start_date: date
    end_date: date
    prices: list[PricePoint]


class Health(BaseModel):
    status: str


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
