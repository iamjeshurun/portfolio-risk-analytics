import math

import pandas as pd
import pytest

from app import analytics


def series(values):
    return pd.Series(values, index=pd.bdate_range("2024-01-01", periods=len(values)), dtype=float)


def test_total_return():
    assert analytics.total_return(series([100, 110, 121])) == pytest.approx(0.21)


def test_max_drawdown():
    assert analytics.max_drawdown(series([100, 120, 90, 108])) == pytest.approx(-0.25)


def test_identical_return_series_are_perfectly_correlated():
    prices = series([100, 103, 101, 106, 104])
    returns = analytics.asset_returns(pd.DataFrame({"A": prices, "B": prices}))
    assert analytics.correlation_matrix(returns).loc["A", "B"] == pytest.approx(1.0)


def test_constant_prices_have_zero_volatility_and_undefined_sharpe():
    returns = analytics.portfolio_returns(series([100, 100, 100, 100]))
    assert analytics.annualized_volatility(returns) == 0.0
    assert analytics.sharpe_ratio(returns, 0.03) is None


def test_portfolio_value_is_buy_and_hold_not_daily_rebalanced():
    prices = pd.DataFrame({"A": series([100, 200, 100]), "B": series([100, 100, 100])})
    weights = pd.Series({"B": 0.5, "A": 0.5})  # deliberately out of column order
    value = analytics.portfolio_value(prices, weights)
    assert value.tolist() == pytest.approx([1.0, 1.5, 1.0])


def test_volatility_and_sharpe():
    returns = analytics.portfolio_returns(series([100, 102, 102, 104.04, 104.04]))
    assert returns.tolist() == pytest.approx([0.02, 0, 0.02, 0])
    assert analytics.annualized_volatility(returns) == pytest.approx(0.01 * math.sqrt(336))
    assert analytics.sharpe_ratio(returns, 0.0) == pytest.approx(math.sqrt(189))
