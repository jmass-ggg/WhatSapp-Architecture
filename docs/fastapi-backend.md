# FastAPI Backend

## Architecture

The application is a synchronous FastAPI service using Pydantic v2,
SQLAlchemy 2.x, Alembic, and PostgreSQL via Psycopg 3. The code is divided into
versioned API routers, request/response schemas, services, repositories, core
configuration/security, and a narrow HTTPX Matrix diagnostics client.

FastAPI owns application accounts, profiles, organization-scoped directory
visibility, application JWTs, refresh-session records, and configurable
entitlements. Synapse remains authoritative for Matrix identities, devices,
rooms, events, message history, receipts, typing, and media. The backend's
Matrix client currently checks `/_matrix/client/versions`; it does not provision
accounts or proxy Matrix traffic.

## Database

The backend uses the separate PostgreSQL 16.15 service in
`compose.backend.yaml`, database `chat_app`, and non-superuser role
`chat_app_app`. The database service has no host port mapping and uses the
persistent volume `realtime-chat-backend-postgres-data`. Synapse's container,
database, role, and volume are separate.

Alembic migrations live in `backend/alembic/`. Apply them explicitly before
starting a new backend deployment:

```sh
docker compose -f compose.backend.yaml run --rm --no-deps backend alembic upgrade head
```

Runtime startup does not modify schemas. The test suite is restricted in
`conftest.py` to `chat_app_test`, verifies that the connected role is not a
superuser, and creates/drops only the test schema there.

## Data Model

| Table | Data and constraints |
| --- | --- |
| `organizations` | UUID, name, unique slug, and creation timestamp. |
| `users` | UUID, case-insensitive unique email and username, Argon2id hash, active/email-verified flags, role, optional organization foreign key, and timestamps. Roles are constrained to `user` or `admin`. |
| `profiles` | One-to-one user foreign key, display name, picture URL, bio, job title, department, organization label, and update timestamp. |
| `subscriptions` | UUID, user, `free`/`pro`/`enterprise` plan, status, start/expiry, optional administrator actor, and timestamps. Database checks validate plan/status and expiry ordering. |
| `refresh_tokens` | UUID, user, unique SHA-256 token hash, family ID, expiry/revocation timestamps, and optional self-reference to the replacing token. |

The model and initial schema are in `backend/app/models/` and
`backend/alembic/versions/0001_initial_schema.py`. Passwords and raw refresh
tokens are not persisted.

## Authentication

- Passwords are validated and hashed with Argon2id; plaintext is never stored.
- Login returns a short-lived JWT for FastAPI endpoints. Its signature,
  expiration, issuer, audience, token purpose, and subject are validated.
- A random refresh token is returned only as an HttpOnly cookie; the database
  stores only its SHA-256 hash. Rotation invalidates the old token, and reuse
  revokes its token family.
- Logout revokes the refresh-token family. Already-issued access JWTs remain
  valid until their short expiry because no access-token denylist is maintained.
- Registration is controlled by `APP_REGISTRATION_ENABLED`; it defaults to
  disabled in `.env.example` and production configuration rejects enabling it.
- The in-memory IP rate limiter is a single-process prototype control. Deploy
  behind a trusted proxy and use a shared rate-limit store before scaling.

Application JWTs are not Matrix access tokens. Matrix login, OIDC, token
exchange, and account provisioning are intentionally not implemented.

## API

All application routes are under `/api/v1`:

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /auth/register` | Registration setting | Create a user, profile, and free placeholder entitlement. |
| `POST /auth/login` | Public, rate-limited | Issue app JWT and HttpOnly refresh cookie. |
| `POST /auth/refresh` | Refresh cookie | Rotate refresh session and issue a new app JWT. |
| `POST /auth/logout` | Refresh cookie | Revoke the token family and clear cookie. |
| `GET /auth/me` | App JWT | Return the authenticated user's account/profile. |
| `GET /users/me`, `PATCH /users/me` | App JWT | Read or update the caller's email/username. |
| `GET /users`, `GET /users/search`, `GET /users/{user_id}` | App JWT and directory entitlement | Paginated, organization-scoped user discovery. |
| `GET /profiles/{user_id}`, `PATCH /profiles/me` | App JWT and visibility rules | Read a visible profile or update the caller's profile. |
| `GET /subscriptions/me`, `GET /subscriptions/plans` | App JWT for `me` | Read current placeholder plan and configured plan catalog. |
| `GET /access/check?feature=...` | App JWT | Evaluate a configured feature entitlement; unknown features are denied. |
| `PUT /subscriptions/{user_id}` | Admin role | Change another user's placeholder entitlement; records the acting admin. |
| `GET /health` | Public | Process liveness. |
| `GET /health` under `/api/v1` | Public | API liveness. |
| `GET /health/ready` under `/api/v1` | Public | Application database readiness. |
| `GET /health/synapse` under `/api/v1` | Public | Separate Synapse API diagnostic. |

Directory search returns username and public profile fields only; it does not
return email or authentication metadata. Users without an organization can
discover only themselves. Account/profile updates operate only on the
authenticated user. Administrative subscription writes require role `admin`.

The Free/Pro/Enterprise labels are illustrative access tiers, not paid plans.
`APP_PLAN_ENTITLEMENTS` is configurable, and business owners must approve
actual plan rules, organization visibility, and administrator assignment
before production use.

## Example Requests

Use a disposable local account. Registration must be enabled in the local
`.env`; the checked-in example keeps it disabled. Replace the password
placeholder locally and do not put a real password in shell history.

```sh
API=http://127.0.0.1:8000
curl -sS -X POST "$API/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"local@example.com","username":"local_user","password":"REPLACE_WITH_A_LOCAL_PASSWORD","display_name":"Local User"}'

ACCESS_TOKEN="$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"login":"local_user","password":"REPLACE_WITH_A_LOCAL_PASSWORD"}' \
  | jq -r '.access_token')"

curl -sS "$API/api/v1/users/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
curl -sS "$API/api/v1/access/check?feature=directory.search" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
unset ACCESS_TOKEN
```

The access token is intentionally omitted from shell output. The login response
also sets the refresh cookie; browser clients should use credentials and the
same `localhost` hostname for the frontend and API in local development.

## Environment and Startup

Never overwrite the existing `.env` when configuring the backend because it
contains local Synapse settings. `scripts/setup/prepare-backend-env.py`
preserves those settings and adds only app-specific random credentials.
`.env.example` contains placeholders, not usable secrets.
The backend Compose service passes an explicit allowlist of app settings and
only the app database/JWT secrets it needs; Synapse database, bootstrap/admin,
and OIDC credentials are not injected into the FastAPI container.

```sh
backend/.venv/bin/python scripts/setup/prepare-backend-env.py
docker compose -f compose.backend.yaml config --quiet
docker compose -f compose.backend.yaml up -d app-postgres
docker compose -f compose.backend.yaml run --rm --no-deps backend alembic upgrade head
docker compose -f compose.backend.yaml up -d backend
docker compose -f compose.backend.yaml ps
docker compose -f compose.backend.yaml logs --tail=100 backend app-postgres
```

FastAPI is loopback-published on port 8000. The backend container connects to
`app-postgres:5432` on its private network and reaches Synapse at
`http://synapse:8008` on the existing Synapse client network. Host processes
must use `127.0.0.1` URLs instead of Docker-only names.

Stop only this Compose project's processes, preserving the database volume:

```sh
docker compose -f compose.backend.yaml stop backend app-postgres
```

Do not use `docker compose down -v` unless intentional app database removal is
approved.

## Testing

The database is not published to the host, so run tests in the backend service
network using the isolated test database:

```sh
docker compose -f compose.backend.yaml run --rm --no-deps backend pytest -q -p no:cacheprovider
```

The tests cover password hashing, registration/login, JWT validation,
refresh-token rotation/reuse/logout, profiles, user visibility/search,
subscription expiry/authorization, health, CORS, and mocked Matrix connectivity.
They do not mutate the Synapse database.

## Limitations

- OIDC and linkage between app users and Matrix users are future work.
- Matrix room creation, messaging, media upload, and E2EE are not implemented.
- The rate limiter is process-local and is not suitable for a multi-worker
  deployment.
- Registration is unverified email-based prototype behavior; verification,
  recovery, MFA, abuse controls, and account lifecycle workflows remain needed.
- Refresh-token reuse revokes its family, but access JWT revocation waits for
  token expiry.
- Subscription tiers are placeholders; there is no payment provider.
- Production deployment still requires TLS, managed secrets, trusted proxy
  configuration, backup/restore drills, audit policy, and a reviewed CSRF
  strategy.
