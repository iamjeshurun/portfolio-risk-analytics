import os

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./portfolio.db")
CACHE_TTL_HOURS = float(os.environ.get("CACHE_TTL_HOURS", "24"))
PROVIDER_TIMEOUT_SECONDS = float(os.environ.get("PROVIDER_TIMEOUT_SECONDS", "10"))
# The /portfolios endpoints keep saved inputs in the shared database. Turn them off on a public deployment,
# where every visitor would see and could delete everyone's saves; the dashboard saves in the browser instead.
SAVED_PORTFOLIOS_ENABLED = os.environ.get("SAVED_PORTFOLIOS_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}
# Comma-separated origins allowed to call the API from a browser, e.g. the GitHub Pages site.
# Empty (the default) adds no CORS headers, which is right when the API serves the page itself.
ALLOWED_ORIGINS = [origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()]
