#!/usr/bin/env bash
set -Eeuo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${SYNAPSE_DATABASE_NAME:?SYNAPSE_DATABASE_NAME is required}"
: "${SYNAPSE_DATABASE_USER:?SYNAPSE_DATABASE_USER is required}"
: "${SYNAPSE_DATABASE_PASSWORD:?SYNAPSE_DATABASE_PASSWORD is required}"

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=synapse_user="$SYNAPSE_DATABASE_USER" \
  --set=synapse_password="$SYNAPSE_DATABASE_PASSWORD" \
  --set=synapse_database="$SYNAPSE_DATABASE_NAME" <<'SQL'
SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L',
    :'synapse_user',
    :'synapse_password'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'synapse_user'
)
\gexec

SELECT format(
    'CREATE DATABASE %I OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0',
    :'synapse_database',
    :'synapse_user',
    'UTF8',
    'C',
    'C'
)
WHERE NOT EXISTS (
    SELECT 1 FROM pg_database WHERE datname = :'synapse_database'
)
\gexec
SQL
