# Local Synapse and PostgreSQL

## Versions and Topology

- Synapse: official `ghcr.io/element-hq/synapse:v1.163.2`.
- PostgreSQL: official `postgres:16.15`.
- Compose project: `realtime-chat-synapse`.
- Synapse client API: `http://127.0.0.1:8008`.
- PostgreSQL: private Compose network only; no host port is published.

The Synapse version tag is pinned to the signed upstream release. PostgreSQL is
pinned to a patch-level official image tag. Upgrade versions deliberately and
take a consistent backup before upgrading.

The Compose file creates a private internal bridge,
`realtime-chat-synapse-internal`, for Synapse and PostgreSQL. Synapse also joins
`realtime-chat-synapse-client`, which allows its loopback-published API port to
be reached from the host; PostgreSQL is not attached to that network. Dedicated
named volumes store:
`realtime-chat-synapse-postgres-data` and
`realtime-chat-synapse-media`. The generated config and signing key are stored
in the ignored `synapse/config/` directory. The database role `synapse` is not
the PostgreSQL bootstrap superuser.

## First-Time Setup

The project uses `SYNAPSE_SERVER_NAME=localhost` for development. Treat this as
immutable after creating users or rooms; changing the server name later changes
Matrix IDs and requires a migration.

1. Generate a local `.env` with independent random database passwords and a
   dedicated FastAPI-to-Synapse JWT key, then create the initial Synapse
   config, signing key, and logging config:

   ```sh
   ./scripts/setup/prepare-synapse.sh
   ```

   The script uses the official image's `generate` command and writes no secret
   values to its output. It sets ownership for the runtime UID and protects the
   generated config and signing key. `.env` and `synapse/config/` are ignored by
   Git. Do not run it again after configuration exists; it refuses to overwrite
   either `.env` or `homeserver.yaml`.

2. Validate the resolved Compose model without printing its secret values:

   ```sh
   docker compose -f compose.synapse.yaml config --quiet
   ```

The official image writes `homeserver.yaml`, signing keys, and logging
configuration under `/data`; this project bind-mounts that path to
`synapse/config/`. A separate named volume stores media. The setup script
applies local-only settings from the sanitized template, including the
`psycopg2` database block, disabled registration and guests, no trusted key
servers, a client-only listener, and the JWT login provider. The JWT signing
key is shared only between FastAPI and Synapse; it is separate from
`APP_JWT_SIGNING_KEY`. PostgreSQL's init script creates the dedicated role and
a UTF-8 database using `C` collation/ctype from `template0`.

## Updating an Existing Local Configuration

For a checkout created before the JWT login integration, preserve its `.env`
and generated Synapse identity. Add the bridge key if it is missing, rewrite
the generated config with the current settings, and recreate the services:

```sh
backend/.venv/bin/python scripts/setup/prepare-backend-env.py
docker compose -f compose.synapse.yaml run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/scripts/setup/configure-synapse.py:/configure-synapse.py:ro" \
  --entrypoint python synapse /configure-synapse.py
docker compose -f compose.synapse.yaml up -d --force-recreate synapse
docker compose -f compose.backend.yaml up -d --build backend
```

The helper preserves existing database passwords and strong signing keys. The
configuration update is idempotent and does not replace Synapse's signing key
or database.

## Start, Stop, and Logs

Start PostgreSQL and wait for its health check:

```sh
docker compose -f compose.synapse.yaml up -d postgres
docker compose -f compose.synapse.yaml ps
```

After PostgreSQL reports healthy and the generated homeserver config is ready:

```sh
docker compose -f compose.synapse.yaml up -d synapse
docker compose -f compose.synapse.yaml ps
```

Inspect logs:

```sh
docker compose -f compose.synapse.yaml logs --tail=100 postgres
docker compose -f compose.synapse.yaml logs --tail=100 synapse
```

Stop only this Compose project without deleting its volumes:

```sh
docker compose -f compose.synapse.yaml down
```

Do not use `down -v`, `docker volume rm`, or prune commands for routine shutdown.
The restart policy is `unless-stopped`. PostgreSQL has a readiness query against
the dedicated Synapse database; Synapse waits for that health check and uses
`/health` for its container health check.

## API and Database Checks

```sh
curl -i http://127.0.0.1:8008/_matrix/client/versions
curl -i http://127.0.0.1:8008/_matrix/client/v3/login
curl -i http://127.0.0.1:8008/health
docker compose -f compose.synapse.yaml exec postgres \
  psql -U synapse -d synapse \
  -c 'SELECT current_database(), current_user, version();'
```

The `/health` endpoint is a process liveness check. The Compose PostgreSQL
health check verifies an authenticated `SELECT 1` using the dedicated database
role. Synapse startup logs should identify PostgreSQL as the selected database;
the local config should show `database.name: psycopg2`, not `sqlite3`.

For a controlled persistence check, record the signing-key checksum without
printing its contents, restart only this project, then compare the checksum and
repeat both HTTP checks:

```sh
sha256sum synapse/config/localhost.signing.key
docker compose -f compose.synapse.yaml restart
docker compose -f compose.synapse.yaml up -d --wait --wait-timeout 180
sha256sum synapse/config/localhost.signing.key
curl -fsS http://127.0.0.1:8008/_matrix/client/versions
```

The named database and media volumes, plus the bind-mounted config directory,
survive container recreation. Back up PostgreSQL with a consistent `pg_dump`
and preserve the matching homeserver config, signing key, and media volume.
Restoring database, config/key, and media from different points in time may
make the server unusable or media unavailable.

## Security and Scope

- Registration and guest access are disabled; no users are provisioned here.
- Federation is denied by an empty `federation_domain_whitelist`, trusted key
  servers are disabled, and the federation API resource is not enabled. Only
  `127.0.0.1:8008` is published.
- PostgreSQL is only on the internal database network. Synapse joins that
  network and the client bridge to provide host access to its published API.
- PostgreSQL has no host port mapping; host PostgreSQL on port 5432 is untouched.
- The homeserver config, generated signing key, `.env`, and data volumes are
  excluded from Git. Never paste passwords, tokens, or key material into logs
  or issue reports.
- This is an HTTP-only local development service. Do not expose it to an
  untrusted network; use a reviewed HTTPS reverse proxy and production
  hardening before deployment.

## Troubleshooting

- **Port 8008 busy:** set `SYNAPSE_HOST_PORT` in `.env` to another loopback port
  (for example `18008`) and update `SYNAPSE_PUBLIC_URL`; the container remains
  on port 8008.
- **PostgreSQL unhealthy:** inspect its logs and verify `.env` passwords, init
  script permissions, and volume ownership. Init scripts run only when the
  PostgreSQL data directory is first initialized.
- **Synapse uses SQLite or fails to connect:** inspect the ignored
  `synapse/config/homeserver.yaml`; verify `database.name: psycopg2`, role,
  database, password, and host `postgres`. Ensure the database health check
  passed before Synapse started.
- **Cannot write config:** verify `LOCAL_UID`/`LOCAL_GID` in `.env` match the
  host user that owns `synapse/config/`. The preparation script applies these
  IDs to the generated config and media volume.
- **Identity/key mismatch:** do not regenerate the config or signing key for an
  initialized data volume. Restore the matching key and database backup.

## References

- [Official Synapse Docker image instructions](https://github.com/element-hq/synapse/blob/develop/docker/README.md)
- [Synapse v1.163.2 release](https://github.com/element-hq/synapse/releases/tag/v1.163.2)
- [Synapse PostgreSQL setup](https://element-hq.github.io/synapse/latest/postgres.html)
- [Synapse configuration manual](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html)
- [Official PostgreSQL Docker image](https://hub.docker.com/_/postgres)
