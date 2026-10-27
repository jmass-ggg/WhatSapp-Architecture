# Development Notes

## Workspace and Environment

The project contains a Vite/React frontend plus Compose-managed Synapse and
FastAPI services. The Python environment is `backend/.venv`; Python
dependencies are pinned in `backend/requirements.txt`. The checked-in
`.env.example` contains placeholders only. Keep the generated local `.env`,
Synapse config/signing key, database credentials, and data out of Git.

Do not overwrite `.env` when adding backend settings. Run
`scripts/setup/prepare-backend-env.py` to add application settings and ensure a
separate FastAPI-to-Synapse JWT key while preserving local database credentials.

## Backend Development

The backend and app PostgreSQL are defined in `compose.backend.yaml`. Database
port 5432 is private and is not published on the host. The backend has an
internal network to `app-postgres` and joins the existing Synapse client
network; it calls Synapse via `http://synapse:8008`. Host-side clients use
`http://127.0.0.1:8000` and `http://127.0.0.1:8008`.
Browser code should use `http://localhost:8000` consistently with
`http://localhost:5173` so the development refresh cookie's `SameSite=Strict`
policy works as intended.

## Frontend Development

The frontend uses React, TypeScript, Vite, React Router, Lucide icons, and
browser `fetch`. Configure the public API URLs in `frontend/.env` from
`frontend/.env.example` when needed; these values are URLs, not secrets. From
the frontend directory:

```sh
npm install
npm run dev
npm run typecheck
npm run build
```

The frontend calls the existing FastAPI auth, profile, and directory routes.
It uses Synapse directly for Matrix sync, direct-room creation, incoming
events, and received-media display. Live sending, uploads, and read markers
are not enabled; the demo preview is local-only and explicitly labeled. See
[`frontend/README.md`](../frontend/README.md) for route behavior and known
limitations.

Apply Alembic migrations explicitly:

```sh
docker compose -f compose.backend.yaml run --rm --no-deps backend alembic upgrade head
```

Run backend tests from the service network against the isolated
`chat_app_test` database:

```sh
docker compose -f compose.backend.yaml run --rm --no-deps backend pytest -q -p no:cacheprovider
```

The test fixture drops and recreates only tables in that database and refuses
to proceed if the configured database or role is unsafe. Never point the test
suite at `chat_app` or Synapse's database.

## Other Verification Layers

- Frontend type checks, unit tests, production builds, and local browser
  integration tests cover authentication, Matrix sync, encrypted text
  exchange, device verification, key recovery, and offline catch-up.
- Keep live-test accounts and rooms synthetic and use only a disposable local
  API/Synapse environment. Encrypted media and production capacity remain
  unverified.
- Performance scenarios are planned for 50, 100, and 500 simulated users,
  including latency, throughput, errors, CPU, and memory.

No production security audit, capacity guarantee, or payment behavior is
claimed as verified. Local E2EE verification evidence is documented in
[End-to-end encryption](end-to-end-encryption.md).
Benchmark artifacts are generated locally under the ignored
`scripts/benchmark/reports/` directory.
