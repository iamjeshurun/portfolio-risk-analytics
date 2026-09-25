import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.database import init_db
from app.errors import register_error_handlers
from app.routes import router

STATIC_DIR = Path(__file__).parent / "static"

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Portfolio Risk Analytics",
    description="Buy-and-hold portfolio performance and risk metrics from cached daily adjusted closes.",
    version="1.0.0",
    lifespan=lifespan,
)
register_error_handlers(app)
app.include_router(router)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
