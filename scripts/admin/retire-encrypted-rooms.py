#!/usr/bin/env python3
"""Inventory and (optionally) delete retired end-to-end encrypted Matrix rooms.

Uses the supported Synapse Admin API only:
  GET    /_synapse/admin/v1/rooms          (list rooms; includes `encryption`)
  DELETE /_synapse/admin/v2/rooms/{id}     (delete room, purge history)

Safety model
  * `inventory` is read-only. It records room IDs and metadata, never message
    content, keys, or user passwords.
  * `delete` is a DRY RUN unless every one of these is true:
      --execute is passed,
      --confirm exactly equals "DELETE <N> ENCRYPTED ROOMS" (N = rooms listed),
      SYNAPSE_ADMIN_TOKEN is set in the environment.
  * Every room is re-checked against the live server immediately before deletion
    and is skipped unless Synapse still reports it as encrypted. Plaintext rooms
    can never be deleted by this tool.
  * Accounts, contacts, subscriptions, and the app database are never touched.
  * Media files uploaded to deleted rooms are NOT removed by room deletion; use
    the Synapse media admin API separately, after review.

Run `delete` against production only with separate, explicit authorization.
Take a Synapse database + media snapshot first (see CHAT_SIMPLIFICATION_RESULT.md).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def call(base: str, token: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Synapse returned HTTP {error.code} for {method} {path}") from None


def list_encrypted_rooms(base: str, token: str) -> list[dict]:
    rooms: list[dict] = []
    offset = 0
    while True:
        page = call(base, token, "GET", f"/_synapse/admin/v1/rooms?limit=100&from={offset}")
        for room in page.get("rooms", []):
            if room.get("encryption"):
                rooms.append({
                    "room_id": room["room_id"],
                    "name": room.get("name"),
                    "encryption": room.get("encryption"),
                    "joined_members": room.get("joined_members"),
                    "joined_local_members": room.get("joined_local_members"),
                    "state_events": room.get("state_events"),
                })
        next_batch = page.get("next_batch")
        if next_batch is None:
            return rooms
        offset = int(next_batch)


def require_token() -> str:
    token = os.environ.get("SYNAPSE_ADMIN_TOKEN", "")
    if not token:
        raise SystemExit("Set SYNAPSE_ADMIN_TOKEN (a Synapse server-admin access token).")
    return token


def cmd_inventory(args: argparse.Namespace) -> None:
    rooms = list_encrypted_rooms(args.homeserver, require_token())
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "homeserver": args.homeserver,
        "encrypted_room_count": len(rooms),
        "rooms": rooms,
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"{len(rooms)} encrypted room(s) written to {args.output}. Nothing was changed.")


def cmd_delete(args: argparse.Namespace) -> None:
    with open(args.inventory, encoding="utf-8") as handle:
        listed = [room["room_id"] for room in json.load(handle)["rooms"]]
    phrase = f"DELETE {len(listed)} ENCRYPTED ROOMS"
    execute = args.execute and args.confirm == phrase
    if args.execute and not execute:
        raise SystemExit(f'--confirm must be exactly: "{phrase}"')
    token = require_token()
    live = {room["room_id"] for room in list_encrypted_rooms(args.homeserver, token)}
    results = []
    for room_id in listed:
        if room_id not in live:
            results.append({"room_id": room_id, "status": "skipped: not currently encrypted/listed"})
        elif not execute:
            results.append({"room_id": room_id, "status": "dry-run: would delete and purge"})
        else:
            quoted = urllib.parse.quote(room_id, safe="")
            call(args.homeserver, token, "DELETE", f"/_synapse/admin/v2/rooms/{quoted}",
                 {"purge": True, "block": True})
            results.append({"room_id": room_id, "status": "delete requested (async); verify with status API"})
    report = {"executed": execute, "results": results}
    with open(args.report, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({"executed": execute, "rooms": len(results)}), f"report: {args.report}")
    if not execute:
        print(f'Dry run only. To execute, add: --execute --confirm "{phrase}"')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--homeserver", default=os.environ.get("SYNAPSE_URL", "http://localhost:8008"))
    sub = parser.add_subparsers(dest="command", required=True)
    inv = sub.add_parser("inventory", help="read-only list of encrypted room IDs")
    inv.add_argument("--output", default="encrypted-rooms-inventory.json")
    inv.set_defaults(func=cmd_inventory)
    dele = sub.add_parser("delete", help="dry-run by default; deletes only with --execute and --confirm")
    dele.add_argument("--inventory", required=True)
    dele.add_argument("--report", default="encrypted-rooms-delete-report.json")
    dele.add_argument("--execute", action="store_true")
    dele.add_argument("--confirm", default="")
    dele.set_defaults(func=cmd_delete)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    sys.exit(main())
