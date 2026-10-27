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
VITE_MATRIX_URL=http://localhost:8008
VITE_MATRIX_SERVER_NAME=localhost
```

Copy `.env.example` to `.env` only if those browser-facing URLs need changing.
They are public URLs, not secrets. Keep the browser hostname as `localhost` for
both Vite and FastAPI so the refresh cookie works with the development
`SameSite=Strict` policy.

Useful checks:

```sh
npm run typecheck
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
token in the optional body field so FastAPI can revoke both sessions.

Access tokens are never written to local or session storage. Reloading the
browser clears the Matrix session held in memory, so the user must log in
again. The refresh endpoint renews only the app JWT, which is why the frontend
does not silently restore a Matrix session after reload.

Google sign-in, password recovery, email verification, and legal/support pages
are not implemented by the backend. The UI reports those features as
unavailable instead of authenticating or claiming those flows exist.

## Matrix integration

FastAPI owns app authentication and returns a distinct Synapse-issued Matrix
session. The browser sends that opaque Matrix access token only to the
configured Synapse URL; it never sends the FastAPI JWT to Synapse.

The browser currently uses the Matrix Client-Server API for:

- Long-poll room sync and timeline updates.
- Private direct-room creation from the authorized FastAPI user directory.
- Text messages, file/image uploads, authenticated media downloads, and read
  receipts.
- Matrix logout through the FastAPI logout request.

There is no FastAPI message or WebSocket endpoint. Matrix sync is the current
real-time update path. The request shapes follow the stable
[Matrix Client-Server API](https://spec.matrix.org/v1.16/client-server-api/)
for [`/sync`](https://spec.matrix.org/v1.16/client-server-api/#get-_matrixclientv3sync),
[`/createRoom`](https://spec.matrix.org/v1.16/client-server-api/#post-_matrixclientv3createroom),
room message events, and media.

LumaChat does not yet use `matrix-js-sdk`. Encrypted rooms are detected and
shown as unsupported; the composer is disabled there rather than sending
plaintext. Device verification, E2EE, encrypted media, typing transmission,
history pagination, moderation, notification delivery, and starred-message
management are not implemented. The UI's mute and wallpaper switches are
session-local preferences and do not update Synapse.

## Demo preview

The login page has an explicit **Preview the chat in clearly labeled demo
mode** action. It uses sample contacts and messages, creates new messages only
in browser state, and shows a persistent demo banner. It does not call the
backend or claim that preview messages are stored remotely. Demo-only
preferences and clearing chat affect only the current preview.
