import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


class AppError(Exception):
    def __init__(self, code: str, message: str, status_code: int, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


def error_response(code: str, message: str, status_code: int, details: dict | None = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(status_code=status_code, content=body)


def validation_error(field: str, message: str) -> AppError:
    return AppError(
        "VALIDATION_ERROR",
        "The request is invalid.",
        422,
        {"errors": [{"field": field, "message": message}]},
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return error_response(exc.code, exc.message, exc.status_code, exc.details)

    @app.exception_handler(RequestValidationError)
    def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = []
        for err in exc.errors():
            location = [str(part) for part in err["loc"] if part not in ("body", "query", "path")]
            message = err["msg"].removeprefix("Value error, ")
            errors.append({"field": ".".join(location) or "body", "message": message})
        return error_response("VALIDATION_ERROR", "The request is invalid.", 422, {"errors": errors})

    @app.exception_handler(Exception)
    def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.error("Unexpected error while handling %s %s", request.method, request.url.path, exc_info=exc)
        return error_response("INTERNAL_ERROR", "An unexpected error occurred.", 500)
