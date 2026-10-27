# System Architecture

## Overview

The browser is both an application client and a Matrix client. The LumaChat
React frontend uses FastAPI for application identity, profiles, and directory
search. After app-password validation, FastAPI exchanges a short-lived,
server-only JWT with Synapse and returns Synapse's Matrix session to the
browser. The frontend uses Synapse's Client-Server API for room sync, direct
room creation, incoming event display, and media downloads. Live message
sending, media uploads, and read-marker submission are deferred. End-to-end
encryption is not implemented.

```mermaid
flowchart LR
    subgraph Browser["Browser"]
        UI["React + TypeScript"]
        APIClient["Application API client"]
        MatrixAPI["Matrix Client-Server API client"]
        UI --> APIClient
        UI --> MatrixAPI
    end

    APIClient -->|"HTTPS REST + app JWT"| FastAPI["FastAPI"]
    MatrixAPI -->|"Matrix Client-Server API + Matrix token"| Synapse["Synapse"]
    FastAPI -->|"Application records"| AppDB[("PostgreSQL: chat_app")]
    Synapse -->|"Homeserver records"| SynapseDB[("PostgreSQL: synapse")]
    FastAPI -->|"Short-lived JWT login assertion"| Synapse
    Synapse -->|"Matrix session from unified login"| FastAPI
    IdP["Future OIDC identity provider"] -.->|"Separate client flows"| FastAPI
    IdP -.->|"Synapse OIDC, future"| Synapse

    subgraph AppNetwork["Backend private network"]
        AppDB
        FastAPI
    end
    subgraph SynapseNetwork["Synapse private network"]
        SynapseDB
        Synapse
    end
    FastAPI ---|"Dedicated client network"| Synapse
```

In deployment, browser-facing API calls go through HTTPS origins/reverse-proxy
routes. Container-only service names such as `synapse` and `postgres` are not
browser URLs. PostgreSQL remains on a private Compose network and its container
port is not published to the host.

## Responsibilities

| Component | Owns |
| --- | --- |
| React frontend | LumaChat login/registration, responsive conversation UI, demo preview, in-memory auth state, read-only Matrix room sync, incoming event display, direct-room creation, and received media display. |
| Browser Matrix API client | Calls Synapse directly for room state, sync, events, direct-room creation, and media downloads. Live text/file sending, uploads, and read markers are not connected; device-key management, encryption, and decryption are also absent. |
| FastAPI | Owns app registration/login, app JWT and refresh sessions, user/profile APIs, directory visibility, configurable entitlements, and the narrow Synapse JWT login/logout exchange. |
| Synapse | Matrix users/devices; room membership/state; message delivery and history; synchronization; typing and receipt events; Matrix authentication; media repository/API; federation if explicitly enabled. |
| PostgreSQL | Separate Synapse and FastAPI containers, databases, non-superuser app roles, private networks, and persistent volumes. |
| Benchmark tooling | Planned repeatable 50-, 100-, and 500-user scenarios and reporting for latency, throughput, errors, CPU, and memory. No capacity claim is made here. |

Do not mirror Matrix messages, room state, receipts, or typing state in FastAPI
unless a future requirement explicitly needs a derived application projection.
Synapse is the source of truth for Matrix data.

## Communication and Event Flow

1. The browser sends the application username/email and password to FastAPI.
2. FastAPI validates the app password, signs a 60-second JWT with the dedicated
   FastAPI-to-Synapse key, and submits it to Synapse's JWT login flow.
3. Synapse maps the stable app-user UUID to a Matrix localpart, creates that
   Matrix account on first login, and returns its own Matrix access token.
4. The browser keeps both returned credentials in memory, uses the app JWT
   only with FastAPI, and starts Matrix sync with the Matrix access token.
5. Synapse persists and routes Matrix events; the browser syncs and renders
   incoming events. The live composer is disabled in this integration stage.
6. Typing and receipt state remain Matrix-owned; this stage does not submit
   read markers or add a read-receipt interface.
7. Logout revokes the app refresh-token family and, when the browser supplies
   its Matrix access token, asks Synapse to revoke that device session.

## Authentication Boundaries

The user enters one application password. FastAPI validates it and creates a
separate short-lived JWT assertion for Synapse. The assertion uses a dedicated
key, issuer, and audience; it is never returned to the browser. Synapse issues
the Matrix access token, and the two access tokens remain valid only for their
respective APIs. Synapse registration through ordinary client requests remains
disabled. See [Authentication](authentication.md) and
[API Boundaries](api-boundaries.md).

## Database Ownership and Network

FastAPI and Synapse use separate PostgreSQL containers, databases (`chat_app`
and `synapse`), roles, networks, and persistent volumes. FastAPI's database is
reachable only over its backend-private network; the backend joins a separate
client network to reach Synapse. Neither PostgreSQL container publishes host
port `5432`. See [Database Design](database-design.md).

Separate databases and roles reduce accidental cross-access but do not provide
the same isolation as separate PostgreSQL clusters or hosts.

## Media

The browser uploads Matrix attachments to Synapse's media API and places the
returned Matrix content URI in the room event. Downloads use an authenticated
request when the homeserver requires it; do not assume an `mxc:` URI can be
used as an unauthenticated image URL. FastAPI does not proxy file bytes.
Encrypted attachment handling requires a Matrix SDK with cryptographic
support and is not implemented.

## Encryption and Security

For encrypted rooms, plaintext exists in the sending/receiving client process;
Synapse stores and routes encrypted event payloads. In unencrypted rooms,
homeservers can read message content. E2EE does not hide all metadata, including
room membership, event timing, and routing information. Encryption is not
implemented or verified in this repository.

Use HTTPS outside local development, strict CORS origins, secure session
handling, least-privilege database roles, secret management outside Git,
rate-limited authentication, and audit-safe logging that omits tokens and
message bodies. Do not expose Synapse administrative APIs publicly.

## Performance Testing

Planned load scenarios live under `scripts/benchmark/scenarios/` and cover 50,
100, and 500 simulated users. A run should report message-delivery latency
(including p50/p95/p99), throughput, error rate, and sampled CPU/RAM for each
service. Reports go to the ignored `scripts/benchmark/reports/` directory.
These scenarios are architecture placeholders; no benchmark has been run and no
capacity has been established.

## References

- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
- [Authenticated Matrix media guide](https://matrix.org/docs/spec-guides/authed-media-servers/)
- [Matrix end-to-end encryption implementation guide](https://matrix.org/docs/matrix-concepts/end-to-end-encryption/)
- [Matrix JavaScript SDK documentation](https://matrix-org.github.io/matrix-js-sdk/)
- [Matrix JS SDK end-to-end encryption support](https://matrix-org.github.io/matrix-js-sdk/#end-to-end-encryption-support)
- [Synapse OpenID Connect configuration](https://element-hq.github.io/synapse/latest/openid.html)
- [Synapse PostgreSQL configuration](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html)
