from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser, get_current_user, get_matrix_client
from app.core.config import settings
from app.core.database import get_db
from app.core.matrix_session_cookie import decode_matrix_session, encode_matrix_session
from app.core.rate_limit import limit_login
from app.core.security import create_synapse_login_token, matrix_localpart
from app.integrations.matrix.client import MatrixClient, MatrixConnectionError, MatrixSession
from app.models.user import User
from app.schemas.auth import (
    AccessTokenResponse,
    LoginRequest,
    LoginResponse,
    LogoutRequest,
    MatrixSessionResponse,
    MessageResponse,
    RegisterRequest,
)
from app.schemas.user import UserMeRead
from app.services.auth import (
    authenticate_user,
    active_refresh_family,
    get_authenticated_user,
    issue_session,
    register_user,
    revoke_refresh_token,
    rotate_refresh_token,
)
from app.services.users import get_visible_user


router = APIRouter(prefix="/auth", tags=["authentication"])
_REFRESH_COOKIE = "app_refresh"
_MATRIX_COOKIE = "app_matrix_session"
logger = logging.getLogger("app.auth")


def _unauthorized_refresh() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Refresh session is invalid",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _set_refresh_cookie(response: Response, value: str) -> None:
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=value,
        max_age=settings.app_refresh_token_ttl_seconds,
        httponly=True,
        secure=settings.app_refresh_cookie_secure,
        samesite="strict",
        path="/api/v1/auth",
    )


def _set_matrix_cookie(
    response: Response, session: MatrixSession, user_id: UUID, family_id: UUID,
) -> None:
    response.set_cookie(
        key=_MATRIX_COOKIE,
        value=encode_matrix_session(session, user_id, family_id),
        max_age=settings.app_refresh_token_ttl_seconds,
        httponly=True,
        secure=settings.app_refresh_cookie_secure,
        samesite="strict",
        path="/api/v1/auth",
    )


def _login_response(access_token: str, session: MatrixSession) -> LoginResponse:
    return LoginResponse(
        access_token=access_token,
        expires_in=settings.app_jwt_ttl_seconds,
        matrix=MatrixSessionResponse(
            access_token=session.access_token,
            user_id=session.user_id,
            device_id=session.device_id,
            home_server=session.home_server,
            expires_in_ms=session.expires_in_ms,
        ),
    )


@router.post(
    "/register",
    response_model=UserMeRead,
    status_code=status.HTTP_201_CREATED,
)
def register(
    payload: RegisterRequest,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if not settings.app_registration_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Registration is disabled",
        )
    return register_user(db, payload)


@router.post(
    "/login",
    response_model=LoginResponse,
    dependencies=[Depends(limit_login)],
)
def login(
    payload: LoginRequest,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    matrix_client: Annotated[MatrixClient, Depends(get_matrix_client)],
    refresh_token: Annotated[str | None, Cookie(alias=_REFRESH_COOKIE)] = None,
    matrix_cookie: Annotated[str | None, Cookie(alias=_MATRIX_COOKIE)] = None,
) -> LoginResponse:
    user = authenticate_user(db, payload.login, payload.password.get_secret_value())
    display_name = (
        user.profile.display_name if user.profile is not None else user.username
    )
    existing = active_refresh_family(db, refresh_token)
    matrix_session = (
        decode_matrix_session(matrix_cookie, user.id, existing[1])
        if existing is not None and existing[0] == user.id else None
    )
    expected_matrix_user_id = f"@{matrix_localpart(user.id)}:{settings.synapse_server_name}"
    if matrix_session is not None and matrix_session.user_id != expected_matrix_user_id:
        matrix_session = None
    created_matrix_session = False
    try:
        if matrix_session is None or not matrix_client.session_is_valid(matrix_session):
            matrix_login_token, _ = create_synapse_login_token(
                user.id, display_name,
            )
            matrix_session = matrix_client.login_with_jwt(
                matrix_login_token, expected_matrix_user_id,
            )
            created_matrix_session = True
    except MatrixConnectionError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Matrix authentication is temporarily unavailable",
        ) from None

    try:
        access_token, new_refresh_token, family_id = issue_session(db, user)
    except Exception:
        if created_matrix_session:
            try:
                matrix_client.logout(matrix_session.access_token)
            except MatrixConnectionError:
                logger.warning("synapse_session_cleanup_failed")
        raise

    _set_refresh_cookie(response, new_refresh_token)
    _set_matrix_cookie(response, matrix_session, user.id, family_id)
    return _login_response(access_token, matrix_session)


@router.post("/restore", response_model=LoginResponse)
def restore(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    matrix_client: Annotated[MatrixClient, Depends(get_matrix_client)],
    refresh_token: Annotated[str | None, Cookie(alias=_REFRESH_COOKIE)] = None,
    matrix_cookie: Annotated[str | None, Cookie(alias=_MATRIX_COOKIE)] = None,
) -> LoginResponse:
    active = active_refresh_family(db, refresh_token)
    if active is None:
        raise _unauthorized_refresh()
    user_id, family_id = active
    matrix_session = decode_matrix_session(matrix_cookie, user_id, family_id)
    expected_matrix_user_id = f"@{matrix_localpart(user_id)}:{settings.synapse_server_name}"
    if matrix_session is None or matrix_session.user_id != expected_matrix_user_id:
        raise _unauthorized_refresh()
    try:
        if not matrix_client.session_is_valid(matrix_session):
            raise _unauthorized_refresh()
    except MatrixConnectionError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Matrix session validation is temporarily unavailable",
        ) from None
    user, access_token, replacement, rotated_family = rotate_refresh_token(db, refresh_token)
    if user.id != user_id or rotated_family != family_id:
        raise _unauthorized_refresh()
    _set_refresh_cookie(response, replacement)
    _set_matrix_cookie(response, matrix_session, user_id, family_id)
    return _login_response(access_token, matrix_session)


@router.post("/refresh", response_model=AccessTokenResponse)
def refresh(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    refresh_token: Annotated[str | None, Cookie(alias=_REFRESH_COOKIE)] = None,
) -> AccessTokenResponse:
    if refresh_token is None:
        raise _unauthorized_refresh()
    _, access_token, replacement, _ = rotate_refresh_token(db, refresh_token)
    _set_refresh_cookie(response, replacement)
    return AccessTokenResponse(
        access_token=access_token,
        expires_in=settings.app_jwt_ttl_seconds,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    matrix_client: Annotated[MatrixClient, Depends(get_matrix_client)],
    refresh_token: Annotated[str | None, Cookie(alias=_REFRESH_COOKIE)] = None,
    payload: LogoutRequest | None = None,
    matrix_cookie: Annotated[str | None, Cookie(alias=_MATRIX_COOKIE)] = None,
) -> Response:
    active = active_refresh_family(db, refresh_token)
    cookie_session = (
        decode_matrix_session(matrix_cookie, active[0], active[1])
        if active is not None else None
    )
    revoke_refresh_token(db, refresh_token)
    logout_token = (
        cookie_session.access_token if cookie_session is not None
        else payload.matrix_access_token.get_secret_value()
        if payload is not None and payload.matrix_access_token is not None else None
    )
    if logout_token is not None:
        try:
            matrix_client.logout(logout_token)
        except MatrixConnectionError:
            # The app refresh session is revoked even if Synapse is unavailable.
            logger.warning("synapse_logout_failed")
    response.delete_cookie(
        key=_REFRESH_COOKIE,
        path="/api/v1/auth",
        httponly=True,
        secure=settings.app_refresh_cookie_secure,
        samesite="strict",
    )
    response.delete_cookie(key=_MATRIX_COOKIE, path="/api/v1/auth")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserMeRead)
def auth_me(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user = get_authenticated_user(db, current_user.id)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user
