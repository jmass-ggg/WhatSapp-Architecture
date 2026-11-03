#!/usr/bin/env python3
"""Register the backend's channel service identity on Synapse as a server admin.

The backend later signs in to this account with the Synapse JWT login (no password is ever
stored or needed again). Server-admin rights let the backend join subscribers to invite-only
channel rooms atomically; without them the backend still works but falls back to invites
that the user's client accepts.

Run once per Synapse deployment, from a machine that can reach the homeserver:

    SYNAPSE_PUBLIC_URL=http://127.0.0.1:8008 python3 scripts/setup/provision-channels-service.py \
        --config synapse/config/homeserver.yaml

Requires ``registration_shared_secret`` in the Synapse config. Idempotent: an existing
account is reported, not changed (promote it with the Synapse admin API or database if needed).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request


def read_shared_secret(config_path: str) -> str:
    with open(config_path, encoding="utf-8") as handle:
        for line in handle:
            match = re.match(r"^registration_shared_secret:\s*(.+?)\s*$", line)
            if match:
                value = match.group(1)
                if value[:1] in "'\"" and value[-1:] == value[:1]:
                    value = value[1:-1]
                return value
    raise SystemExit("registration_shared_secret is not set in the Synapse configuration")


def request(
    url: str, method: str = "GET", body: dict | None = None, token: str | None = None
) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except ValueError:
            payload = {}
        return error.code, payload


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--config", default="synapse/config/homeserver.yaml", help="Synapse homeserver.yaml"
    )
    parser.add_argument(
        "--url", default=os.environ.get("SYNAPSE_PUBLIC_URL", "http://127.0.0.1:8008")
    )
    parser.add_argument(
        "--localpart",
        default=os.environ.get("SYNAPSE_CHANNELS_SERVICE_LOCALPART", "channels_service"),
        help="Must match SYNAPSE_CHANNELS_SERVICE_LOCALPART of the backend",
    )
    args = parser.parse_args()
    if args.localpart.startswith("u_"):
        raise SystemExit("The service localpart must not use the application user prefix 'u_'")

    base = args.url.rstrip("/")
    shared_secret = read_shared_secret(args.config)
    status, payload = request(f"{base}/_synapse/admin/v1/register")
    if status != 200 or "nonce" not in payload:
        raise SystemExit(f"Could not obtain a registration nonce (status {status}): {payload}")
    nonce = payload["nonce"]

    # The password is random and discarded: the backend authenticates with JWT login only.
    password = secrets.token_urlsafe(48)
    mac = hmac.new(shared_secret.encode("utf-8"), digestmod=hashlib.sha1)
    for index, part in enumerate((nonce, args.localpart, password, "admin")):
        if index:
            mac.update(b"\x00")
        mac.update(part.encode("utf-8"))
    status, payload = request(
        f"{base}/_synapse/admin/v1/register",
        "POST",
        {
            "nonce": nonce,
            "username": args.localpart,
            "displayname": "Channels",
            "password": password,
            "admin": True,
            "mac": mac.hexdigest(),
        },
    )
    if status == 400 and payload.get("errcode") == "M_USER_IN_USE":
        print(f"Service account @{args.localpart} already exists; nothing changed.")
        print("If it is not a server admin, promote it with the Synapse admin API.")
        return 0
    if status != 200:
        raise SystemExit(f"Registration failed (status {status}): {payload}")
    user_id = payload["user_id"]
    token = payload.get("access_token")

    # Confirm the admin flag with the fresh session, then discard the session.
    if token:
        status, info = request(f"{base}/_synapse/admin/v1/users/{user_id}/admin", token=token)
        is_admin = status == 200 and info.get("admin") is True
        request(f"{base}/_matrix/client/v3/logout", "POST", {}, token=token)
    else:
        is_admin = False
    print(
        f"Registered service account {user_id} "
        f"(server admin: {'yes' if is_admin else 'unverified'})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
