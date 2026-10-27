# LumaChat frontend

This is the React/TypeScript/Vite client for the existing FastAPI and Synapse
services. It does not change the backend's JWT or Matrix authentication flow.

## Run locally

Start FastAPI and Synapse using the root project's setup instructions. Then:

```sh
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The defaults are:

```text
VITE_API_URL=http://localhost:8000/api/v1
VITE_MATRIX_HOMESERVER_URL=http://localhost:8008
VITE_MATRIX_SERVER_NAME=localhost
```

Copy `.env.example` to `.env` only if those browser-facing URLs need changing.
They are public URLs, not secrets. Keep the browser hostname as `localhost` for
both Vite and FastAPI so the refresh cookie works with the development
`SameSite=Strict` policy.

Useful checks:

```sh
npm run typecheck
npm test
npm run build
```

## Routes and account behavior

| Route | Behavior |
| --- | --- |
| `/login` | Calls `POST /api/v1/auth/login`; keeps the app JWT and Synapse Matrix session in memory. |
| `/register` | Calls `POST /api/v1/auth/register`; sends email, username, password, and display name. Registration must be enabled by the backend. |
| `/chat` | Protected conversation view. On desktop it opens the first available conversation; on mobile it shows the conversation list. |
| `/chat/:conversationId` | Protected selected conversation. |
| `/` | Redirects to `/chat` when an in-memory session exists, otherwise `/login`. |

The app calls `GET /api/v1/users/me` for the current profile and
`GET /api/v1/users/search` for the new-chat directory. It rotates the app JWT
through `POST /api/v1/auth/refresh` after an authenticated API request receives
a 401. Logout calls `POST /api/v1/auth/logout` and sends the Matrix session
token in the optional body field so FastAPI can revoke the app refresh session
and request Matrix-session revocation.

Access tokens are never written to local or session storage. Reloading the
browser clears the Matrix session held in memory, so the user must log in
again. The refresh endpoint renews only the app JWT, which is why the frontend
does not silently restore a Matrix session after reload.

Google sign-in, password recovery, email verification, and legal/support pages
are not implemented by the backend. The UI reports those features as
unavailable instead of authenticating or claiming those flows exist.

## Matrix integration

FastAPI owns app authentication and returns the Synapse-issued Matrix session
in the existing login response. The frontend validates the expected Matrix ID,
checks the credentials with Synapse `whoami`, then creates one managed
`matrix-js-sdk` client for that authenticated browser session. The app JWT is
never sent to Synapse, and the raw Matrix token is not persisted in browser
storage. Before sync, the client initializes the SDK's Rust/WASM crypto with
an IndexedDB store namespaced to the homeserver, Matrix user, and Matrix
device. A browser Web Lock prevents concurrent crypto clients from opening
that store.

The SDK owns long-poll synchronization, room/event models, and event delivery.
The UI marks initial sync complete only when the SDK emits
`SyncState.Prepared`; it relies on the SDK for reconnect and catch-up behavior.
New direct rooms are created encrypted from their initial state. The live text
composer sends only when both the room state and Rust crypto confirm encryption;
existing plaintext rooms fail closed. Timeline content is rendered as plain
text, and the SDK refreshes the room model when decryption completes.
Attachments and read-marker submission are not implemented. The demo
composer remains local-only.

Device identity, cross-signing, interactive SAS verification, encrypted key
backup, and recovery-key setup are available in **Encryption and devices**.
The app uses the SDK's strict signed-device policy; an unverified device is
not silently trusted. New devices need an existing trusted backup and the
user's recovery key to restore history. See the
[E2EE guide](../docs/end-to-end-encryption.md) for the session lifecycle,
storage limits, recovery procedure, and security assumptions. There is no
FastAPI message or WebSocket endpoint.

Run the SDK-level and browser E2EE tests only against a disposable local
development/test API and nonproduction Synapse. They create synthetic
accounts, devices, rooms, and messages that remain on those services:

```sh
LUMACHAT_TEST_API_URL=http://localhost:8000/api/v1 \
LUMACHAT_MATRIX_HOMESERVER_URL=http://localhost:8008 \
LUMACHAT_MATRIX_SERVER_NAME=localhost \
npm run test:e2ee-live

LUMACHAT_TEST_API_URL=http://localhost:8000/api/v1 \
LUMACHAT_MATRIX_HOMESERVER_URL=http://localhost:8008 \
LUMACHAT_MATRIX_SERVER_NAME=localhost \
LUMACHAT_WEB_URL=http://localhost:5173 \
CHROMIUM_EXECUTABLE=/opt/google/chrome/chrome \
npm run test:e2ee-browser
```

Never point the scripts at shared or production services. The separate
`npm run test:matrix-live` command checks the earlier authentication,
room-sync, reconnect, logout, and account-isolation flows.

Browser Matrix requests need a browser-reachable Synapse URL such as
`http://localhost:8008`; Docker-only hostnames such as `http://synapse:8008`
are not resolvable by the browser. FastAPI and Synapse CORS settings must allow
the Vite origin.

## Demo preview

The login page has an explicit **Preview the chat in clearly labeled demo
mode** action. It uses sample contacts and messages, creates new messages only
in browser state, and shows a persistent demo banner. It does not call the
backend or claim that preview messages are stored remotely. Demo-only
preferences and clearing chat affect only the current preview.
