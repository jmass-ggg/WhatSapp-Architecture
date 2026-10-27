# Database Ownership and Isolation

## Ownership

| Database | Owner/service | Data boundary |
| --- | --- | --- |
| `synapse` | Synapse PostgreSQL container | Matrix users/devices, rooms, events, state, sync data, and homeserver metadata. |
| `chat_app` | FastAPI PostgreSQL container | Application accounts, profiles, organization records, subscriptions, and hashed refresh sessions. |
| `chat_app_test` | FastAPI test suite | Isolated test fixtures only; tests may create and drop its tables. |

These are separate PostgreSQL containers, Compose networks, volumes, and
database roles, not merely separate schemas on one server. Neither PostgreSQL
container publishes port 5432 to the host. Synapse owns Matrix conversation
state; FastAPI must not duplicate messages, room membership, typing, or receipts
as authoritative application data.

## Roles and Credentials

- `synapse` is the dedicated Synapse database role.
- `chat_app_app` is the non-superuser FastAPI application role and cannot
  create roles or databases.
- `chat_app_admin` bootstraps the application PostgreSQL container and is not
  used by FastAPI.
- The test suite confirms it is connected to `chat_app_test` as a non-superuser
  before creating or dropping tables.

Local database credentials are stored only in ignored `.env`. The committed
`.env.example` contains replacement placeholders. Production credentials
belong in a secret manager, not source control, image layers, or frontend
bundles.

## Container Networks and Persistence

`compose.backend.yaml` places `app-postgres` on the private
`realtime-chat-backend-internal` network with the backend. The backend also
joins the existing Synapse client network to reach Synapse, but the application
database is not connected to that network. Synapse PostgreSQL remains on its
own private network. This prevents host port conflicts and keeps database
traffic off browser-facing networks.

The application database volume is `realtime-chat-backend-postgres-data`.
Synapse's database and media use their separately named persistent volumes.
Database roles and networks reduce accidental access but do not replace
backups, encryption at rest, host security, or a tested restore procedure.

## Schema and Migration Ownership

- FastAPI schema changes are versioned in `backend/alembic/`; deploy them
  explicitly with `alembic upgrade head`. Runtime startup does not mutate the
  schema.
- Synapse owns and migrates its internal tables. Do not alter them directly.
- `database/init/` contains first-initialization role/database setup, including
  the dedicated application test database; it is not the migration system.
- Backups and restore tests must cover each PostgreSQL database plus Synapse
  media and server identity/signing-key material.

The FastAPI application connects to `app-postgres:5432` only from the Compose
network, using database `chat_app` and role `chat_app_app`. Host-side test
processes cannot resolve that internal name; run tests through the backend
Compose service against `chat_app_test`.
