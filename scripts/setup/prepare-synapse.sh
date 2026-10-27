#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -e .env ]]; then
  printf 'Refusing to overwrite existing %s/.env\n' "$ROOT_DIR" >&2
  exit 1
fi

if [[ -e synapse/config/homeserver.yaml ]]; then
  printf 'Refusing to overwrite existing Synapse configuration or identity\n' >&2
  exit 1
fi

command -v openssl >/dev/null || {
  printf 'openssl is required to generate local database passwords and JWT keys\n' >&2
  exit 1
}

umask 077
cp .env.example .env
synapse_db_password="$(openssl rand -hex 32)"
synapse_jwt_signing_key="$(openssl rand -hex 32)"
postgres_password="$(openssl rand -hex 32)"
local_uid="$(id -u)"
local_gid="$(id -g)"

sed -i \
  -e "s|^POSTGRES_SUPERUSER_PASSWORD=.*|POSTGRES_SUPERUSER_PASSWORD=${postgres_password}|" \
  -e "s|^SYNAPSE_DATABASE_PASSWORD=.*|SYNAPSE_DATABASE_PASSWORD=${synapse_db_password}|" \
  -e "s|^SYNAPSE_JWT_SIGNING_KEY=.*|SYNAPSE_JWT_SIGNING_KEY=${synapse_jwt_signing_key}|" \
  -e "s|^LOCAL_UID=.*|LOCAL_UID=${local_uid}|" \
  -e "s|^LOCAL_GID=.*|LOCAL_GID=${local_gid}|" \
  .env
chmod 0600 .env
unset synapse_db_password synapse_jwt_signing_key postgres_password

docker compose -f compose.synapse.yaml run --rm --no-deps synapse generate
docker compose -f compose.synapse.yaml run --rm --no-deps \
  --user 0:0 \
  --entrypoint sh synapse \
  -ceu "
    chown '${local_uid}:${local_gid}' /data
    find /data -maxdepth 1 -type f -exec chown '${local_uid}:${local_gid}' {} +
    chmod 0700 /data
    chmod 0600 /data/homeserver.yaml
    find /data -maxdepth 1 -type f -name '*.signing.key' -exec chmod 0600 {} +
    find /data -maxdepth 1 -type f -name '*.log.config' -exec chmod 0640 {} +
    install -d -o '${local_uid}' -g '${local_gid}' -m 0750 /data/media_store
  "
docker compose -f compose.synapse.yaml run --rm --no-deps \
  --user "${local_uid}:${local_gid}" \
  -v "$ROOT_DIR/scripts/setup/configure-synapse.py:/configure-synapse.py:ro" \
  --entrypoint python synapse /configure-synapse.py

printf 'Synapse configuration generated. Secret values were not displayed.\n'
