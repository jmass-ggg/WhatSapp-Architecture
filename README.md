# LumaChat

Development workspace for a Matrix Synapse, FastAPI, React, and PostgreSQL
chat application. It includes a responsive React interface, FastAPI
identity/profile and access-control APIs, unified app-password-to-Matrix
login, and a browser Matrix SDK client for authenticated room sync, encrypted
text exchange, device verification, and encrypted-history recovery.

## Architecture and Boundaries

- [LumaChat frontend setup and integration notes](frontend/README.md)
- [System architecture](docs/architecture.md)
- [API boundaries](docs/api-boundaries.md)
- [Authentication and token boundaries](docs/authentication.md)
- [Matrix end-to-end encryption](docs/end-to-end-encryption.md)
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
backend environment helper:

```sh
backend/.venv/bin/python scripts/setup/prepare-backend-env.py
docker compose -f compose.backend.yaml config --quiet
docker compose -f compose.backend.yaml up -d app-postgres
docker compose -f compose.backend.yaml run --rm --no-deps backend alembic upgrade head
docker compose -f compose.backend.yaml up -d backend
```

The helper writes random app database and JWT secrets to the ignored `.env`;
the app JWT key and FastAPI-to-Synapse bridge key are generated separately.
The helper does not print or replace Synapse database credentials. Development
registration is enabled by that helper for local verification. The committed
`.env.example` keeps registration disabled.
For an existing checkout created before unified login, also follow the
configuration update steps in [Local Synapse setup](docs/synapse-setup.md)
before testing Matrix login.

## Local Frontend

Start the Synapse and backend services as described above, then run Vite:

```sh
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The app uses `http://localhost:8000/api/v1` for
FastAPI and `http://localhost:8008` for Synapse by default; override them with
`VITE_API_URL`, `VITE_MATRIX_HOMESERVER_URL`, and `VITE_MATRIX_SERVER_NAME` in
`frontend/.env`. A clearly labeled demo preview is available from the login
page. Live login requires the backend and Synapse services to be running.
The pinned official `matrix-js-sdk` initializes Rust crypto before sync.
New rooms and live text messages use Matrix E2EE; plaintext rooms fail closed.
See the [Matrix frontend integration guide](docs/matrix-frontend-integration.md)
and [E2EE guide](docs/end-to-end-encryption.md) for device, recovery, and test
details.

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
