"""Pure financial calculations. No database or provider access.

Conventions: 252 trading days per year, sample statistics (ddof=1), rates as decimals.
"""

import math

import pandas as pd

TRADING_DAYS = 252
ZERO_VARIANCE_TOLERANCE = 1e-12


def asset_returns(prices: pd.DataFrame) -> pd.DataFrame:
    """Daily percentage returns per asset; the first date has no return and is dropped."""
    return prices.pct_change(fill_method=None).iloc[1:]


def normalized_prices(prices: pd.DataFrame) -> pd.DataFrame:
    """Each asset's price relative to its first observation (starts at 1.0)."""
    return prices / prices.iloc[0]


def portfolio_value(prices: pd.DataFrame, weights: pd.Series) -> pd.Series:
    """Buy-and-hold portfolio value starting at 1.0. Weights are aligned to columns by symbol."""
    if set(weights.index) != set(prices.columns):
        raise ValueError("weights and price columns must contain the same symbols")
    return normalized_prices(prices).mul(weights, axis=1).sum(axis=1)


def portfolio_returns(value: pd.Series) -> pd.Series:
    return value.pct_change(fill_method=None).dropna()


def total_return(value: pd.Series) -> float:
    return float(value.iloc[-1] / value.iloc[0] - 1)


def annualized_return(total: float, observations: int) -> float | None:
    if observations < 1 or 1 + total < 0:
        return None
    return float((1 + total) ** (TRADING_DAYS / observations) - 1)


def annualized_volatility(returns: pd.Series) -> float | None:
    if len(returns) < 2:
        return None
    return float(returns.std(ddof=1) * math.sqrt(TRADING_DAYS))


def drawdown(value: pd.Series) -> pd.Series:
    return value / value.cummax() - 1


def max_drawdown(value: pd.Series) -> float:
    return float(drawdown(value).min())


def sharpe_ratio(returns: pd.Series, risk_free_rate: float) -> float | None:
    """Annualized Sharpe ratio; None when excess returns have (near-)zero dispersion."""
    if len(returns) < 2:
        return None
    daily_rf = (1 + risk_free_rate) ** (1 / TRADING_DAYS) - 1
    excess = returns - daily_rf
    std = excess.std(ddof=1)
    if std < ZERO_VARIANCE_TOLERANCE:
        return None
    return float(excess.mean() / std * math.sqrt(TRADING_DAYS))


def correlation_matrix(returns: pd.DataFrame) -> pd.DataFrame:
    """Pearson correlations of daily returns; NaN where an asset's returns are constant."""
    return returns.corr(method="pearson")
