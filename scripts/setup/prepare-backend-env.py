#!/usr/bin/env python3
"""Set app and Synapse JWT bridge secrets without replacing local credentials."""

from __future__ import annotations

import os
import re
import secrets
import stat
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
SECRET_PLACEHOLDER = re.compile(r"REPLACE|CHANGE_ME|example", re.IGNORECASE)


def main() -> None:
    if not ENV_FILE.is_file() or ENV_FILE.is_symlink():
        raise SystemExit("Expected a regular local .env; run the existing Synapse setup first.")

    original = ENV_FILE.read_text(encoding="utf-8")
    lines = original.splitlines()
    values: dict[str, str] = {}
    indexes: dict[str, int] = {}

    for index, line in enumerate(lines):
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not match:
            continue
        key, value = match.groups()
        if key in indexes:
            raise SystemExit(f"Duplicate environment key: {key}")
        values[key] = value
        indexes[key] = index

    if values.get("APP_ENV", "development") != "development":
        registration_enabled = "false"
    else:
        registration_enabled = "true"

    updates = {
        "APP_DATABASE_NAME": "chat_app",
        "APP_TEST_DATABASE_NAME": "chat_app_test",
        "APP_DATABASE_USER": "chat_app_app",
        "APP_DATABASE_HOST": "app-postgres",
        "APP_DATABASE_PORT": "5432",
        "APP_POSTGRES_IMAGE_TAG": "16.15",
        "APP_DATABASE_ADMIN_USER": "chat_app_admin",
        "APP_REGISTRATION_ENABLED": registration_enabled,
    }
    if "APP_PLAN_ENTITLEMENTS" not in values:
        updates["APP_PLAN_ENTITLEMENTS"] = (
            '{"directory.search":["free","pro","enterprise"],'
            '"profile.extended":["pro","enterprise"]}'
        )

    for key in (
        "APP_DATABASE_PASSWORD",
        "APP_DATABASE_ADMIN_PASSWORD",
        "APP_JWT_SIGNING_KEY",
        "SYNAPSE_JWT_SIGNING_KEY",
    ):
        current = values.get(key, "")
        if len(current) < 32 or SECRET_PLACEHOLDER.search(current):
            updates[key] = (
                secrets.token_urlsafe(48)
                if key in {"APP_JWT_SIGNING_KEY", "SYNAPSE_JWT_SIGNING_KEY"}
                else secrets.token_hex(32)
            )

    if (
        values.get("APP_JWT_SIGNING_KEY")
        and values.get("APP_JWT_SIGNING_KEY") == values.get("SYNAPSE_JWT_SIGNING_KEY")
    ):
        updates["SYNAPSE_JWT_SIGNING_KEY"] = secrets.token_urlsafe(48)

    for key, value in updates.items():
        if key in indexes:
            lines[indexes[key]] = f"{key}={value}"
        else:
            lines.append(f"{key}={value}")

    content = "\n".join(lines) + "\n"
    file_mode = stat.S_IMODE(ENV_FILE.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".env.backend.", dir=ROOT)
    try:
        os.fchmod(descriptor, min(file_mode, 0o600))
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, ENV_FILE)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise

    print("Updated app settings and ensured separate strong application and Synapse JWT secrets.")


if __name__ == "__main__":
    main()
