# Development Notes

## Workspace and Environment

The project contains the existing frontend architecture plus Compose-managed
Synapse and FastAPI services. The Python environment is `backend/.venv`; Python
dependencies are pinned in `backend/requirements.txt`. The checked-in
`.env.example` contains placeholders only. Keep the generated local `.env`,
Synapse config/signing key, database credentials, and data out of Git.

Do not overwrite `.env` when adding backend settings. Run
`scripts/setup/prepare-backend-env.py` to add app-only secrets while preserving
the existing Synapse settings.

## Backend Development

The backend and app PostgreSQL are defined in `compose.backend.yaml`. Database
port 5432 is private and is not published on the host. The backend has an
internal network to `app-postgres` and joins the existing Synapse client
network; it calls Synapse via `http://synapse:8008`. Host-side clients use
`http://127.0.0.1:8000` and `http://127.0.0.1:8008`.
Browser code should use `http://localhost:8000` consistently with
`http://localhost:5173` so the development refresh cookie's `SameSite=Strict`
policy works as intended.

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

- Frontend unit/component tests will cover UI and API/Matrix service boundaries
  when the frontend is implemented.
- Integration and E2E tests should use isolated accounts and verify login,
  room activity, upload, and encryption UX after those features exist.
- Performance scenarios are planned for 50, 100, and 500 simulated users,
  including latency, throughput, errors, CPU, and memory.

No E2EE, production capacity, or payment behavior is claimed as verified.
Benchmark artifacts are generated locally under the ignored
`scripts/benchmark/reports/` directory.
