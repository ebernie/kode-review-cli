"""
Shared-secret authentication for the local indexer API.
"""

import os
import secrets
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


API_SECRET_HEADER = "x-kode-review-indexer-secret"
API_SECRET_ENV = "KODE_REVIEW_INDEXER_API_SECRET"


def is_authorized(expected: Optional[str], supplied: Optional[str]) -> bool:
    if not expected:
        return True
    return secrets.compare_digest(supplied or "", expected)


def install_indexer_api_auth(app: FastAPI):
    @app.middleware("http")
    async def require_api_secret(request: Request, call_next):
        expected = os.environ.get(API_SECRET_ENV)
        supplied = request.headers.get(API_SECRET_HEADER)
        if not is_authorized(expected, supplied):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid indexer API secret"},
            )
        return await call_next(request)

    return require_api_secret
