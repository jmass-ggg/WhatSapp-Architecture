# API Boundaries

## Communication Paths

```text
React Frontend
      |
      |---- Application REST APIs ----> FastAPI
      |                                    |
      |                                    └── Application PostgreSQL database
      |
      |---- Matrix Client API -------> Synapse
                                           |
                                           └── Synapse PostgreSQL database

FastAPI ---- Controlled Matrix integration ----> Synapse
```

In local development the browser uses loopback-published FastAPI and Synapse
URLs. Docker-only names such as `http://synapse:8008` are for container-to-
container traffic and are used by the backend integration client, not by the
browser. Production browser traffic must use intentional HTTPS origins.

## FastAPI-Owned Operations

FastAPI owns application accounts, profile metadata, organization-scoped
directory visibility, app JWTs and refresh sessions, feature entitlements, and
health checks. Implemented routes include:

| Route | Responsibility |
| --- | --- |
| `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`; `GET /api/v1/auth/me` | App authentication and session lifecycle. Login returns an app JWT plus a Synapse-issued Matrix session. |
| `GET/PATCH /api/v1/users/me`; `GET /api/v1/users`, `/search`, `/{user_id}` | Self-service account changes and authorized directory lookup. |
| `GET /api/v1/profiles/{user_id}`; `PATCH /api/v1/profiles/me` | Read a visible profile or update the caller's profile. |
| `GET /api/v1/subscriptions/me`, `/plans`; `GET /api/v1/access/check` | Illustrative plans and configured feature checks. |
| `PUT /api/v1/subscriptions/{user_id}` | Admin-only entitlement updates. |
| `GET /health`, `/api/v1/health`, `/api/v1/health/ready` | Process and application database status. |
| `GET /api/v1/health/synapse` | Separate Matrix versions-endpoint diagnostic. |

The backend's Matrix client performs the versions check and a narrow login
exchange. After validating an app password, FastAPI sends Synapse a
short-lived, server-signed JWT using Synapse's `org.matrix.login.jwt` flow.
Synapse creates the mapped Matrix account on first login and issues the Matrix
access token. FastAPI does not create passwords in Synapse or proxy rooms,
synchronization, media, typing, or receipts.

## Matrix-Owned Operations

The LumaChat browser uses the official Matrix JavaScript SDK with the
Synapse-issued session returned by FastAPI login. It uses the Matrix
Client-Server API directly for:

- Room membership, room state, timeline sync, and event delivery.
- Direct-room creation from the existing user-directory flow.
- Incoming typing and receipt-related state, plus media downloads for received
  avatars and attachments.

The live timeline is read-only in this integration stage. The live composer,
message/file sending, media uploads, and read-marker submission are not
connected; the existing message composer remains available in demo mode.

FastAPI owns the app-password authentication and exchanges a short-lived
server-signed JWT for the Synapse session. The browser does not submit a Matrix
password or create an independent Matrix login. Device verification, E2EE,
and encrypted attachments are not implemented by this frontend.

Synapse is the source of truth for these operations. The Matrix specification
defines its own client authentication and access tokens; these are not
FastAPI-issued credentials. See the [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/).

## JWT and Matrix Token Separation

| Credential | Issuer | Audience/use | Must not be used for |
| --- | --- | --- | --- |
| Application JWT | FastAPI after app-owned password login | FastAPI application REST endpoints only | Synapse Client-Server API, database login, or identity-provider login |
| FastAPI-to-Synapse login assertion | FastAPI, signed with a dedicated shared secret and 60-second expiry | The Synapse JWT login endpoint only | Browser storage, FastAPI API authorization, or Matrix Client-Server API calls |
| Matrix access token | Synapse after validating the login assertion | Matrix Client-Server API and the corresponding Matrix device/session | FastAPI authorization |
| Synapse JWT signing key | Shared by FastAPI and Synapse server configuration | Validating the server-side login assertion | Browser storage, app JWT signing, logs, or ordinary user Matrix requests |

The app JWT is not forwarded to Synapse. FastAPI creates a separate assertion
after password validation, and returns only the app JWT and Synapse-issued
Matrix access token. A stable Matrix localpart is derived from the immutable
application user UUID rather than a mutable username or email address.

## Login and Logout Flow

FastAPI validates the supplied app password and then requests a Matrix session
from Synapse. If Synapse cannot complete the exchange, login fails closed and
FastAPI does not issue an app refresh session. The browser uses the app JWT for
FastAPI and the Matrix access token for direct Matrix API calls. On logout,
clients can send the Matrix access token in the optional request body so
FastAPI can revoke the Matrix device session and the app refresh-token family.

The app returns short-lived JWTs in JSON and stores refresh tokens only as
hashes server-side while sending the raw refresh token in an HttpOnly cookie.
Keep access tokens short-lived, use exact CORS origins, and review CSRF,
cookie, TLS, and trusted-proxy behavior before production. Matrix session
credentials are kept in frontend memory and are not written to local storage.
Reloading the page requires a new login because the current backend refresh
route renews only the app JWT, not the Matrix session. Never log tokens or
expose the shared JWT signing key to the browser.

Synapse's JWT login is a non-standard, server-side flow documented for the
selected Synapse release:
[Synapse JWT Login Type](https://element-hq.github.io/synapse/v1.163/jwt.html).

OIDC remains a future alternative; configuration and compatibility must be
checked against the selected Synapse release before implementation:
[Synapse OIDC documentation](https://element-hq.github.io/synapse/latest/openid.html).

## E2EE and Message Payloads

In a non-encrypted room, normal message events contain readable message content
at the homeserver. In an encrypted room, the client SDK encrypts the event before
submission; Synapse stores/routes the encrypted event and recipient clients use
their device/session keys to decrypt it. The SDK must own encryption, key
management, device verification, and decryption; application JWTs do not encrypt
Matrix events.

Encrypted media must also be encrypted client-side. The Matrix media service
stores the uploaded bytes and returns a Matrix content URI; the event carries
the information the receiving SDK needs to decrypt the attachment. E2EE protects
content, not all metadata, and does not protect plaintext from a compromised
endpoint. Use the SDK's authenticated media support where the homeserver
requires authorization; browser `<img>` loads must not assume media is public.
Missing keys, unverified devices, and recovery flows must be surfaced in the UI
rather than silently treating content as verified.

The planned client is `matrix-js-sdk`; use its documented Rust/WASM crypto API
and persistent crypto storage, and enforce one active client per crypto store.
The [Matrix JS SDK encryption documentation](https://matrix-org.github.io/matrix-js-sdk/#end-to-end-encryption-support)
documents initialization, secret storage, device verification, backup, and
storage constraints. E2EE is not implemented or verified by this backend step.
