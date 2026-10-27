# Authentication and Token Boundaries

## Application Login and Matrix Session

Users register and sign in with the application's email/username and password.
Registration creates an application user, profile, and free illustrative
subscription; it is controlled by `APP_REGISTRATION_ENABLED`, which is false in
`.env.example`. Email verification and account recovery flows are not
implemented.

Passwords are hashed with Argon2id. Successful login returns a short-lived
application JWT and a Synapse-issued Matrix session in the response body. It
also sets a random refresh token in an HttpOnly, SameSite=Strict cookie scoped
to `/api/v1/auth`. Only a SHA-256 hash of the refresh token is stored in the
application database. Refresh rotates app tokens; reuse of a revoked token
revokes the whole family. Existing app JWTs cannot be revoked early and expire
naturally.

The app JWT has explicit issuer and audience claims and is validated for
signature, expiry, issuer, audience, subject, and token purpose. It is accepted
only by FastAPI application endpoints. To obtain the Matrix session, FastAPI
signs a separate, 60-second JWT with a dedicated secret and sends it directly
to Synapse's `org.matrix.login.jwt` login flow. Synapse provisions the Matrix
user on first login and returns a Matrix access token. The short-lived bridge
JWT is never returned to the browser. The Matrix user localpart is derived from
the immutable application user UUID (`u_<uuid-without-hyphens>`), avoiding
collisions with manually created Synapse accounts. Synapse stores no separate
user password for this flow.

The browser keeps the app JWT and Matrix access token in memory, not local
storage. The app refresh cookie is not readable by JavaScript. When logging
out, send the Matrix access token in the optional `matrix_access_token` field
so FastAPI can revoke the app refresh-token family and attempt Synapse session
revocation. App logout still succeeds if Synapse is unavailable; Matrix
revocation is best-effort in that case.

Development uses `APP_REFRESH_COOKIE_SECURE=false` over loopback HTTP. Set it
to true behind HTTPS; production configuration rejects insecure refresh
cookies and public registration. The login rate limiter is process-local and
must be replaced by a shared store before using multiple workers. Exact CORS
origins are configured; production deployment still requires reviewed CSRF,
proxy, and session policies.

## Token and Secret Boundaries

The app JWT and Matrix access token are distinct credentials with separate
issuers and audiences. The app JWT is only for FastAPI; the Matrix access token
is only for the Matrix Client-Server API. Neither token is accepted in place
of the other. The backend-to-Synapse bridge key is stored only in the ignored
local `.env` and Synapse's ignored generated configuration. It must be
different from `APP_JWT_SIGNING_KEY` and must never appear in browser responses
or logs.

The Synapse login type is server-side and non-standard; the browser does not
need to support it. FastAPI validates the user's password first, then creates
a signed assertion with a fixed issuer, audience, short expiry, and stable
Matrix localpart. Synapse registration remains disabled for ordinary client
requests. If OIDC is introduced later, use separate client/audience validation
for FastAPI and Synapse.

## Matrix Device and Encryption Keys

The browser uses the Matrix JavaScript SDK for sync, but does not initialize
Rust crypto or manage device keys and encrypted events. A future E2EE stage
must own device verification, key-backup/recovery, and encryption UX. Matrix
cryptographic keys are distinct from JWT signing keys. Loss of Matrix device
keys can make encrypted history unreadable; key recovery must be designed and
tested. E2EE has not been implemented or verified.
