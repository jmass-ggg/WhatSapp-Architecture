# Authentication and Token Boundaries

## Current Application Authentication

The prototype currently uses app-owned email/username and password credentials.
Registration creates an application user, profile, and free illustrative
subscription; it is controlled by `APP_REGISTRATION_ENABLED`, which is false in
`.env.example`. Email verification and account recovery flows are not
implemented.

Passwords are hashed with Argon2id. Successful login returns a short-lived
application JWT in the response body and sets a random refresh token in an
HttpOnly, SameSite=Strict cookie scoped to `/api/v1/auth`. Only a SHA-256 hash
of the refresh token is stored in the application database. Refresh rotates
tokens; reuse of a revoked token revokes the whole family. Logout revokes the
family. Existing access JWTs cannot be revoked early and expire naturally.

The JWT has explicit issuer and audience claims and is validated for signature,
expiry, issuer, audience, subject, and token purpose. It is accepted only by
FastAPI application endpoints. The browser should keep the short-lived access
token in memory, not local storage. The refresh cookie is not readable by
JavaScript.

Development uses `APP_REFRESH_COOKIE_SECURE=false` over loopback HTTP. Set it
to true behind HTTPS; production configuration rejects insecure refresh
cookies and public registration. The login rate limiter is process-local and
must be replaced by a shared store before using multiple workers. Exact CORS
origins are configured; production deployment still requires reviewed CSRF,
proxy, and session policies.

## Matrix Credentials Are Separate

Synapse retains its own Matrix authentication and issues Matrix access tokens
through Matrix-supported login. No FastAPI JWT is passed to Synapse, and no
Matrix access token is accepted as an application JWT. The backend currently
performs only an unauthenticated Matrix versions check; it does not provision
or link Matrix accounts. OIDC and an explicit application-user-to-Matrix-user
mapping are future work.

If OIDC is introduced, use separate client/audience validation for FastAPI and
Synapse, and link identities by a stable issuer and subject pair (`iss`, `sub`).
Do not infer account linkage from mutable usernames or email addresses. Any
future Synapse provisioning credential must remain server-side, least
privileged, and absent from logs and responses.

## Matrix Device and Encryption Keys

When implemented, the Matrix client SDK will own Matrix sessions, device keys,
encrypted-event handling, key backup/recovery, and verification UX. Matrix
cryptographic keys are distinct from JWT signing keys. Loss of Matrix device
keys can make encrypted history unreadable; key recovery must be designed and
tested. E2EE has not been implemented or verified by this backend step.
