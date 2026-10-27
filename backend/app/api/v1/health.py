from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.dependencies import get_matrix_client
from app.core.database import check_database, get_db
from app.integrations.matrix.client import MatrixClient, MatrixConnectionError


logger = logging.getLogger("app.health")
router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def api_liveness() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready", response_model=None)
def readiness(db: Annotated[Session, Depends(get_db)]) -> dict[str, str] | JSONResponse:
    try:
        check_database(db)
    except SQLAlchemyError:
        logger.warning("database_readiness_check_failed")
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "database": "unavailable"},
        )
    return {"status": "ready", "database": "ok"}


@router.get("/synapse", response_model=None)
def synapse_health(
    client: Annotated[MatrixClient, Depends(get_matrix_client)],
) -> dict[str, int | str] | JSONResponse:
    try:
        return client.health()
    except MatrixConnectionError:
        logger.warning("synapse_health_check_failed")
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable"},
        )
