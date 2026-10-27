from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        case_sensitive=False,
        extra="ignore",
        validate_default=True,
    )

    app_name: str = "Realtime Chat Prototype"
    app_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    fastapi_host: str = "0.0.0.0"
    fastapi_port: int = Field(default=8000, ge=1, le=65535)
    cors_allowed_origins: str = "http://localhost:5173"

    app_database_host: str = "app-postgres"
    app_database_port: int = Field(default=5432, ge=1, le=65535)
    app_database_name: str = "chat_app"
    app_test_database_name: str = "chat_app_test"
    app_database_user: str = "chat_app"
    app_database_password: SecretStr
    app_database_pool_size: int = Field(default=5, ge=1, le=50)
    app_database_max_overflow: int = Field(default=5, ge=0, le=50)

    app_registration_enabled: bool = False
    app_jwt_issuer: str = "realtime-chat-api"
    app_jwt_audience: str = "realtime-chat-api"
    app_jwt_algorithm: Literal["HS256"] = "HS256"
    app_jwt_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    app_jwt_signing_key: SecretStr
    app_refresh_token_ttl_seconds: int = Field(default=2_592_000, ge=3600, le=31_536_000)
    app_refresh_cookie_secure: bool = False
    app_login_rate_limit_attempts: int = Field(default=10, ge=1, le=100)
    app_login_rate_limit_window_seconds: int = Field(default=60, ge=1, le=3600)
    app_directory_rate_limit_attempts: int = Field(default=30, ge=1, le=1000)
    app_directory_rate_limit_window_seconds: int = Field(default=60, ge=1, le=3600)

    synapse_server_name: str = Field(
        default="localhost",
        min_length=1,
        max_length=255,
    )
    synapse_internal_url: str = "http://synapse:8008"
    synapse_request_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    synapse_jwt_issuer: str = Field(
        default="realtime-chat-synapse-login",
        min_length=1,
        max_length=200,
    )
    synapse_jwt_audience: str = Field(
        default="realtime-chat-synapse",
        min_length=1,
        max_length=200,
    )
    synapse_jwt_algorithm: Literal["HS256"] = "HS256"
    synapse_jwt_ttl_seconds: int = Field(default=60, ge=15, le=300)
    synapse_jwt_signing_key: SecretStr

    app_plan_entitlements: dict[str, list[str]] = Field(
        default_factory=lambda: {
            "directory.search": ["free", "pro", "enterprise"],
            "profile.extended": ["pro", "enterprise"],
        }
    )

    @field_validator("app_database_name", "app_test_database_name", "app_database_user")
    @classmethod
    def validate_postgres_identifier(cls, value: str) -> str:
        if not value or len(value) > 63 or not value.replace("_", "").isalnum():
            raise ValueError("Database names and users must be safe PostgreSQL identifiers")
        return value

    @field_validator("cors_allowed_origins")
    @classmethod
    def validate_cors_origins(cls, value: str) -> str:
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if not origins or "*" in origins:
            raise ValueError("CORS origins must be explicit; wildcard origins are not allowed")
        if any(not origin.startswith(("http://", "https://")) for origin in origins):
            raise ValueError("CORS origins must be absolute HTTP(S) origins")
        return ",".join(origins)

    @model_validator(mode="after")
    def validate_security_settings(self) -> Settings:
        if self.app_database_name == self.app_test_database_name:
            raise ValueError("The application and test databases must be distinct")
        if len(self.app_jwt_signing_key.get_secret_value().encode("utf-8")) < 32:
            raise ValueError("APP_JWT_SIGNING_KEY must contain at least 32 bytes")
        synapse_signing_key = self.synapse_jwt_signing_key.get_secret_value()
        if len(synapse_signing_key.encode("utf-8")) < 32:
            raise ValueError("SYNAPSE_JWT_SIGNING_KEY must contain at least 32 bytes")
        if synapse_signing_key == self.app_jwt_signing_key.get_secret_value():
            raise ValueError("Application and Synapse JWT signing keys must be different")
        if self.app_env == "production":
            if self.app_registration_enabled:
                raise ValueError("Public registration must be disabled in production")
            if not self.app_refresh_cookie_secure:
                raise ValueError("Refresh cookies must be Secure in production")
        valid_plans = {"free", "pro", "enterprise"}
        if any(not set(plans).issubset(valid_plans) for plans in self.app_plan_entitlements.values()):
            raise ValueError("Entitlements may reference only configured plan identifiers")
        return self

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]

    @property
    def database_url(self) -> URL:
        return URL.create(
            drivername="postgresql+psycopg",
            username=self.app_database_user,
            password=self.app_database_password.get_secret_value(),
            host=self.app_database_host,
            port=self.app_database_port,
            database=self.app_database_name,
        )

    @property
    def test_database_url(self) -> URL:
        return self.database_url.set(database=self.app_test_database_name)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
