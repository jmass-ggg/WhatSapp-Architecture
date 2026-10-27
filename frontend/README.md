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
storage.

The SDK owns long-poll synchronization, room/event models, and event delivery.
The UI marks initial sync complete only when the SDK emits
`SyncState.Prepared`; it relies on the SDK for reconnect and catch-up behavior.
Live Matrix rooms are read-only in this step: the composer and attachment
controls are disabled, and the UI does not send messages, upload media, or
submit read markers. The composer remains a local-only interaction in demo
mode. Message rendering uses plain text and ignores untrusted formatted HTML.
Encrypted-room decryption is not configured in this step.

There is no FastAPI message or WebSocket endpoint. See the root
[Matrix frontend integration guide](../docs/matrix-frontend-integration.md) for
session handling, CORS, logout, reconnect, future E2EE, and live-test steps.

The real browser/Synapse test is opt-in and creates synthetic users and rooms
in an isolated test database. Do not point it at a shared or production API.
The guide describes the required test server and environment variables.

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
