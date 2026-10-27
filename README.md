# Realtime Chat Prototype

Development workspace for a Matrix Synapse, FastAPI, React, and PostgreSQL
chat application. The local Synapse service and the application identity,
profile, directory, and access-control API are implemented. The React client,
Matrix messaging UI, OIDC, media workflows, and E2EE client are not part of
this backend step.

## Architecture and Boundaries

- [System architecture](docs/architecture.md)
- [API boundaries](docs/api-boundaries.md)
- [Authentication and token boundaries](docs/authentication.md)
- [Database ownership](docs/database-design.md)
- [FastAPI backend guide](docs/fastapi-backend.md)
- [Local Synapse setup](docs/synapse-setup.md)
- [Development notes](docs/development.md)

FastAPI uses a dedicated `chat_app` database and role in its own PostgreSQL
container. Synapse keeps its separate database, role, and container. Neither
database publishes port 5432 to the host.

## Local Backend Startup

The existing `.env` is local-only and must retain the generated Synapse values.
On first setup, use the Synapse preparation instructions before running the
app-only environment helper:

```sh
backend/.venv/bin/python scripts/setup/prepare-backend-env.py
docker compose -f compose.backend.yaml config --quiet
docker compose -f compose.backend.yaml up -d app-postgres
docker compose -f compose.backend.yaml run --rm --no-deps backend alembic upgrade head
docker compose -f compose.backend.yaml up -d backend
```

The helper writes random app database and JWT secrets to the ignored `.env`;
it does not print or replace Synapse credentials. Development registration is
enabled by that helper for local verification. The committed `.env.example`
keeps registration disabled.

The API is loopback-published on port 8000. Use `http://localhost:8000` from a
browser with the frontend at `http://localhost:5173`, keeping the hostname
consistent for the `SameSite=Strict` refresh cookie; `127.0.0.1` also works for
curl. Swagger is at `/docs`; liveness, database readiness, and Synapse
diagnostics are at `/health`, `/api/v1/health/ready`, and
`/api/v1/health/synapse`.
Backend-to-Synapse calls use Docker DNS at `http://synapse:8008` over the
existing Synapse client network. A host process cannot resolve that service
name.

Run the suite inside the private Compose network against its dedicated
`chat_app_test` database:

```sh
docker compose -f compose.backend.yaml run --rm --no-deps backend pytest -q -p no:cacheprovider
```

To stop only the backend stack without removing persistent data:

```sh
docker compose -f compose.backend.yaml stop backend app-postgres
```

Never use `down -v` for routine shutdown; it removes the app database volume.
See [the backend guide](docs/fastapi-backend.md) for migrations, endpoints,
tests, and operational details.
