#!/usr/bin/env bash
set -Eeuo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${APP_DATABASE_NAME:?APP_DATABASE_NAME is required}"
: "${APP_DATABASE_USER:?APP_DATABASE_USER is required}"
: "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}"
: "${APP_TEST_DATABASE_NAME:?APP_TEST_DATABASE_NAME is required}"

for identifier in "$APP_DATABASE_NAME" "$APP_DATABASE_USER" "$APP_TEST_DATABASE_NAME"; do
  if [[ ! "$identifier" =~ ^[a-z][a-z0-9_]*$ ]]; then
    printf 'Invalid application database identifier\n' >&2
    exit 1
  fi
done

if [[ "$APP_TEST_DATABASE_NAME" == "$APP_DATABASE_NAME" ]] ||
  [[ "$APP_DATABASE_NAME" != "$POSTGRES_DB" ]]; then
  printf 'Invalid or conflicting application database names\n' >&2
  exit 1
fi

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=app_database="$APP_DATABASE_NAME" \
  --set=app_role="$APP_DATABASE_USER" \
  --set=app_password="$APP_DATABASE_PASSWORD" \
  --set=test_database="$APP_TEST_DATABASE_NAME" <<'SQL'
SELECT format(
    'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
    :'app_role',
    :'app_password'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'app_role'
)
\gexec

SELECT format(
    'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
    :'app_role',
    :'app_password'
)
\gexec

SELECT format(
    'ALTER DATABASE %I OWNER TO %I',
    :'app_database',
    :'app_role'
)
\gexec

REVOKE ALL ON DATABASE :"app_database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"app_database" TO :"app_role";

SELECT format(
    'CREATE DATABASE %I WITH OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0',
    :'test_database',
    :'app_role',
    'UTF8',
    'C',
    'C'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_database WHERE datname = :'test_database'
)
\gexec

SELECT format(
    'ALTER DATABASE %I OWNER TO %I',
    :'test_database',
    :'app_role'
)
\gexec

REVOKE ALL ON DATABASE :"test_database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"test_database" TO :"app_role";
SQL
