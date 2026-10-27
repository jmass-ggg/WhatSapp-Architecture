# Matrix Frontend Integration

## SDK and runtime

The frontend pins the official `matrix-js-sdk` package to `44.0.0`. The
package's Node engine range includes Node 22. The official GitHub release page
listed `v44.0.0` as the latest stable release while `v45.0.0-rc.0` was a
pre-release when this integration was checked on 2026-10-27:
[matrix-js-sdk releases](https://github.com/matrix-org/matrix-js-sdk/releases).

Install the lockfile-pinned dependencies with:

```sh
cd frontend
npm ci
```

The browser homeserver URL is configured with
`VITE_MATRIX_HOMESERVER_URL`; `VITE_MATRIX_URL` remains a code-level fallback
for older local environment files. Use a URL reachable from the browser, such
as `http://localhost:8008`. Docker's `http://synapse:8008` name is only
resolvable by other containers. `VITE_MATRIX_SERVER_NAME` must match the
Synapse server name used by FastAPI.

## FastAPI authentication and client creation

`POST /api/v1/auth/login` remains the only login flow. FastAPI verifies the
application password and returns the app JWT plus the existing
`matrix.access_token`, `matrix.user_id`, `matrix.device_id`, and homeserver
metadata. The frontend does not create a second Matrix login flow.

The client computes the expected Matrix ID from the logged-in FastAPI user ID
using the same `@u_<UUID without hyphens>:<server name>` mapping as the
backend. It rejects a missing session or a Matrix ID that does not match that
mapping. Before synchronization it calls the SDK's `whoami()` method and
checks the returned user and device IDs against the FastAPI login response.
FastAPI's JWT is sent only to FastAPI; the opaque Matrix access token is sent
only to the configured Synapse homeserver.

`MatrixClientRegistry` owns one SDK client for the current authenticated
browser session. It reuses the client across React StrictMode effect
re-invocation, disposes it on account changes, and isolates the SDK memory
store for each session. The token is held in React/application memory only;
the SDK's room cache is also configured as in-memory state. No raw Matrix
access token is written to `localStorage` or `sessionStorage`.

The client is not initialized for demo or unauthenticated state. Matrix
initialization failures are exposed as connection state and do not silently
fall back to demo messages.

## Synchronization and event handling

After the identity check, the client calls the supported `startClient()` API
with a bounded initial timeline. Listeners are attached before startup.
Calling `startClient()` is not treated as proof that sync succeeded: the UI
marks the client ready only after `SyncState.Prepared`, when the SDK reports
that initial sync data is available.

The session manager maps these SDK states to UI state:

| SDK state | UI behavior |
| --- | --- |
| `PREPARED` | Initial sync is complete; rooms are available. |
| `SYNCING` | Connected, or catching up if the SDK marks the sync as catch-up. |
| `CATCHUP`, `RECONNECTING` | Keep existing room data and show reconnecting. |
| `ERROR` | Let the SDK retry transient sync errors; stop on an authentication failure. |
| `STOPPED` | Clear connection state. |

The client responds to SDK room, timeline, room-state, membership, typing,
receipt, deletion, and sync events. It derives room lists and timeline content
from SDK room models, sorts and deduplicates message IDs, and keeps a bounded
recent-event record. Unsupported event types are ignored. `m.room.message`
text is rendered as React text; `formatted_body` is not interpreted as HTML.
An encrypted event is labeled as unavailable because Rust crypto has not been
initialized in this step.

The current React UI consumes the SDK-backed room state and connection status.
The existing demo conversations remain explicitly marked demo-only and are
not included in the live Matrix room list.

Live room timelines are read-only in this step. The message composer and file
controls are disabled for authenticated Matrix sessions; text/file sends,
media uploads, and read-marker submission are deferred. The existing composer
continues to work only inside the local demo preview. The existing directory
flow may create a direct Matrix room, but this step does not implement group
chat or a production message composer.

## Reconnects, expiry, and logout

The SDK owns `/sync` retry, reconnect, and catch-up behavior. LumaChat does not
start a parallel polling loop or create new Matrix sessions for temporary
network errors. A later successful sync returns the UI to connected and
updates rooms with events received while offline.

Transient sync errors are shown as reconnecting while the SDK retries. A
Synapse authentication response such as HTTP 401 or `M_UNKNOWN_TOKEN` stops
the client and shows that the Matrix session expired or was revoked; the UI
does not repeatedly retry an invalid credential. A FastAPI refresh failure
clears application state and stops the matching Matrix client. A fresh login
is required if the Matrix session is rejected.

The pinned SDK also probes the optional MSC4143 `/rtc/transports` endpoint
when a client starts. Synapse v1.163.2 returns 404 because this application
does not use Matrix RTC; the SDK treats that response as a cached unsupported
feature. The live browser test permits only this known endpoint-specific 404
and fails on other HTTP or console errors.

On sign-out, LumaChat stops sync and removes SDK listeners before calling the
existing FastAPI logout endpoint. FastAPI revokes the refresh session and
attempts Synapse logout when given the Matrix token. If Synapse is unavailable,
the backend's Matrix revocation is best-effort; the frontend only claims that
its local client has stopped.

Authentication state and Matrix credentials are held in memory. A browser
reload clears both, and the user must sign in again. The refresh cookie can
rotate the app JWT but the current backend does not provide a Matrix-session
recovery endpoint or persist Matrix device credentials. The frontend therefore
does not silently create a replacement device after reload. Safe persistent
recovery needs a backend-owned session/device design that can restore or
revoke the correct Matrix device without exposing its token to browser
storage.

## CORS and local browser access

FastAPI's CORS allowlist must include the Vite origin, normally
`http://localhost:5173`, with credentials enabled for the refresh cookie.
Synapse must allow browser requests from the Vite origin and the browser must
use its published URL, normally `http://localhost:8008`. The local services
were checked with browser-origin preflight requests during this integration.

## Automated and live tests

The frontend tests cover client configuration and credentials, identity
validation, initial-sync transitions, live event deduplication, room mapping,
reconnect state, listener cleanup, expired tokens, and account changes:

```sh
cd frontend
npm run typecheck
npm test
npm run build
```

The opt-in browser test uses real FastAPI, Synapse, and Chromium. It registers
two random synthetic users, signs User A in through the React login page,
creates a test room, has User B send a real Matrix event, checks the received
event's room ID, event ID, sender, and type in the UI, verifies the live
composer is disabled, interrupts only the test browser's connectivity, and
verifies catch-up. It then signs out User A, signs User B in, checks that User
A's private room is absent, and checks the mobile layout and auth-route
navigation.

Run the test only against the isolated `chat_app_test` database. In one
terminal, start a temporary backend container mapped to port 8001. This does
not replace the regular backend on port 8000:

```sh
FASTAPI_PORT=8001 docker compose -f compose.backend.yaml run --rm --service-ports \
  -e APP_DATABASE_NAME=chat_app_test \
  -e APP_TEST_DATABASE_NAME=chat_app_test_harness \
  -e CORS_ALLOWED_ORIGINS=http://localhost:5174 \
  -e APP_REGISTRATION_ENABLED=true \
  backend sh -c 'alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000'
```

In another terminal, start Vite pointed at that test API and the local
Synapse:

```sh
cd frontend
VITE_API_URL=http://localhost:8001/api/v1 \
VITE_MATRIX_HOMESERVER_URL=http://localhost:8008 \
npm run dev -- --port 5174
```

Then run the browser integration test:

```sh
cd frontend
LUMACHAT_TEST_API_URL=http://localhost:8001/api/v1 \
LUMACHAT_MATRIX_HOMESERVER_URL=http://localhost:8008 \
LUMACHAT_MATRIX_SERVER_NAME=localhost \
npm run test:matrix-live
```

The script uses `/usr/bin/chromium-browser` by default; set
`CHROMIUM_EXECUTABLE` if Chromium is installed elsewhere. The test permits the
pinned SDK's expected 404 for Synapse's unsupported optional MSC4143 RTC
endpoint and reports it separately; other browser HTTP or console errors fail
the test. It never prints passwords or access tokens. It logs out the test
Matrix sessions and browser sessions; the synthetic account rows remain in
the test database, and the test-only Matrix rooms/messages remain on Synapse.

## Security and E2EE boundary

This stage synchronizes Matrix events but does not implement or verify
end-to-end encryption. It does not call deprecated legacy crypto
initialization APIs, and it does not claim encrypted-room contents can be
decrypted. Matrix messages and room names are untrusted input and are rendered
as text.

A future E2EE stage should:

- Call the SDK's supported `initRustCrypto()` exactly once for the managed
  client and await it before starting sync.
- Use the SDK's Rust/WASM crypto implementation with IndexedDB-backed crypto
  storage. Do not create multiple clients that share one IndexedDB crypto
  store; the official SDK warns that concurrent access can corrupt crypto
  state. See the [official SDK repository](https://github.com/matrix-org/matrix-js-sdk).
- Define secure session recovery that preserves a stable Matrix device ID and
  device identity across refreshes without putting raw access tokens in
  browser storage.
- Implement recovery-key backup/restore, device verification, cross-signing,
  encrypted timeline event handling, and multi-device key synchronization.
- Test encryption and decryption between independently verified devices;
  ciphertext presence alone is not proof of E2EE.

Those requirements are future work and are not enabled by this integration.
