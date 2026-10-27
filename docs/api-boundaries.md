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
| `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`; `GET /api/v1/auth/me` | App-owned authentication and session lifecycle. |
| `GET/PATCH /api/v1/users/me`; `GET /api/v1/users`, `/search`, `/{user_id}` | Self-service account changes and authorized directory lookup. |
| `GET /api/v1/profiles/{user_id}`; `PATCH /api/v1/profiles/me` | Read a visible profile or update the caller's profile. |
| `GET /api/v1/subscriptions/me`, `/plans`; `GET /api/v1/access/check` | Illustrative plans and configured feature checks. |
| `PUT /api/v1/subscriptions/{user_id}` | Admin-only entitlement updates. |
| `GET /health`, `/api/v1/health`, `/api/v1/health/ready` | Process and application database status. |
| `GET /api/v1/health/synapse` | Separate Matrix versions-endpoint diagnostic. |

The backend's Matrix client currently performs only the versions check. It
does not create accounts or rooms, proxy messages, synchronization, media,
typing, or receipts. Any future provisioning must be narrowly scoped,
idempotent, explicitly authorized, and audited.

## Matrix-Owned Operations

When implemented, the Matrix SDK will use the Matrix Client-Server API directly
for:

- Matrix authentication/session and device management.
- Direct/group rooms, membership, room state, and message send/history.
- Incremental synchronization and event delivery.
- Typing notifications and read receipts.
- Media upload/download and Matrix content URIs.
- Device keys, encrypted-room events, and encrypted attachments.

Synapse is the source of truth for these operations. The Matrix specification
defines its own client authentication and access tokens; these are not
FastAPI-issued credentials. See the [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/).

## JWT and Matrix Token Separation

| Credential | Issuer | Audience/use | Must not be used for |
| --- | --- | --- | --- |
| Application JWT | FastAPI after app-owned password login (OIDC is future work) | FastAPI application REST endpoints only | Synapse Client-Server API, database login, or identity-provider login |
| Matrix access/refresh token | Synapse through its supported Matrix/OIDC login flow | Matrix Client-Server API and the corresponding Matrix device/session | FastAPI authorization unless a specific token-exchange design is separately reviewed |
| Synapse admin credential | Synapse/admin provisioning process | Server-side administrative provisioning only, if needed | Browser storage or ordinary user Matrix requests |

Do not derive a Matrix token from an app JWT, forward one token as the other, or
assume Synapse accepts arbitrary FastAPI JWTs. OIDC-based identity correlation
and an app-user-to-Matrix-user record are future work; no account linkage is
currently configured.

## Secure Login Integration Proposal

Current local app login uses a username/email and password; Matrix login is
not integrated and must remain a separate flow. A future SSO design may use a
trusted OIDC provider with separate clients/audiences for FastAPI and Synapse.
FastAPI must validate credentials intended for its API and issue a short-lived
app JWT, while Synapse issues its own Matrix token/device session. Neither
service accepts the other's token.

The app returns short-lived JWTs in JSON and stores refresh tokens only as
hashes server-side while sending the raw refresh token in an HttpOnly cookie.
Keep access tokens short-lived, use exact CORS origins, and review CSRF,
cookie, TLS, and trusted-proxy behavior before production. Matrix credentials
belong to the Matrix SDK session/device store. Never log tokens or expose a
Synapse admin credential to the browser.

Synapse has OIDC integration documentation; configuration and compatibility
must be checked against the selected Synapse release before implementation:
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
