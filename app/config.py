import os

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./portfolio.db")
CACHE_TTL_HOURS = float(os.environ.get("CACHE_TTL_HOURS", "24"))
PROVIDER_TIMEOUT_SECONDS = float(os.environ.get("PROVIDER_TIMEOUT_SECONDS", "10"))
# Comma-separated origins allowed to call the API from a browser, e.g. the GitHub Pages site.
# Empty (the default) adds no CORS headers, which is right when the API serves the page itself.
ALLOWED_ORIGINS = [origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()]
