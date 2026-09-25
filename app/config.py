import os

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./portfolio.db")
CACHE_TTL_HOURS = float(os.environ.get("CACHE_TTL_HOURS", "24"))
PROVIDER_TIMEOUT_SECONDS = float(os.environ.get("PROVIDER_TIMEOUT_SECONDS", "10"))
