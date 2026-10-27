# LumaChat — Interview Cheat Sheet

Detailed source-backed answers, diagrams, file map, and six demo walkthroughs: [LUMACHAT_INTERVIEW_QA.md](./LUMACHAT_INTERVIEW_QA.md).

## 60-second introduction

I built LumaChat as a real-time messaging prototype for a recruitment SaaS platform. React and TypeScript provide the browser UI; FastAPI owns application identity, profiles, organization-scoped directory search, and illustrative subscription entitlements. After app login, FastAPI exchanges a short-lived JWT assertion with Matrix Synapse and returns the app JWT plus a separate Matrix session. The browser uses `matrix-js-sdk` and Matrix Rust Crypto to sync rooms and send encrypted text directly to Synapse. PostgreSQL stores app data separately from Synapse’s messaging data. The core login, directory, Matrix room, and encrypted-text paths exist, but I do not claim production readiness: Step 08 is committed in `d0ed3a0`, encrypted media and session restoration are missing, and live E2EE/browser/load tests were not run for this review.

## 2-minute architecture explanation

The browser has two clients and two trust boundaries. `ApiClient` sends app requests to FastAPI with the app JWT and refresh cookie. The Matrix SDK sends Matrix Client-Server API requests directly to Synapse using a Synapse-issued Matrix access token.

At login, FastAPI verifies the password, signs a short-lived server-only JWT for Synapse’s JWT login provider, and validates the Matrix account returned by Synapse. The React app keeps both resulting sessions in memory. `MatrixContext` starts a managed SDK session, verifies the Matrix `whoami` identity, initializes Rust Crypto with a per-device IndexedDB store, then starts sync.

FastAPI stores users, profiles, organizations, subscriptions, and refresh-token hashes in the application PostgreSQL database. Synapse stores Matrix accounts/devices, rooms, events, room state, and sync data in a separate PostgreSQL database. Docker Compose keeps those databases and their volumes separate; FastAPI joins the Matrix client network to call Synapse for login. For chat, FastAPI authorizes directory search, then the browser maps the selected app UUID to a Matrix ID, creates or reuses a private encrypted room, invites the contact, and sends text through the Matrix SDK. The recipient’s SDK syncs and decrypts before React renders the event.

## 15 high-value interview questions

1. **What is LumaChat?** A chat prototype alongside a recruitment SaaS, not a completed ATS integration; no candidate/job workflow model is present.
2. **What is the architecture?** React calls FastAPI for app identity/directory and Synapse directly for Matrix; FastAPI and Synapse own separate PostgreSQL databases.
3. **What is complete?** Current frontend unit tests pass 6 files / 33 tests and TypeScript typecheck passes. Step 08 is committed, but live E2EE/browser tests and load tests were not run.
4. **How are organizations modeled?** `users.organization_id` is a nullable FK to `organizations`; there is no membership join table. `Profile.organization` is free text, not tenant membership.
5. **Is chat subscription-gated?** No global chat gate exists. `directory.search` is checked by a FastAPI dependency and is enabled for every plan in the example entitlement map.
6. **How is directory privacy enforced?** FastAPI filters by the authenticated user’s organization; an unassigned user sees only themselves. This does not automatically constrain a Matrix access token.
7. **Why two PostgreSQL databases?** FastAPI owns product data; Synapse owns Matrix protocol state and message data. Separate services own and migrate their schemas independently.
8. **How does login reach Synapse?** FastAPI verifies an app password, signs a short-lived Matrix JWT assertion, posts it to Synapse’s JWT login endpoint, and returns the Synapse session.
9. **Why are the tokens different?** The app JWT authorizes FastAPI. The Matrix token authorizes Synapse. The bridge JWT is server-to-server and short-lived.
10. **What happens when Alice sends Bob a message?** The browser finds Bob through FastAPI, creates/reuses an encrypted room, invites him, locally encrypts text through the SDK, and sends the Matrix event to Synapse; Bob syncs and decrypts.
11. **How is E2EE implemented?** Matrix Rust Crypto in the browser, private rooms with `m.room.encryption` and `m.megolm.v1.aes-sha2`, guarded SDK sends, no plaintext fallback.
12. **How is E2EE proven?** Unit tests cover guards and event mapping. The live harness asserts Synapse sees `m.room.encrypted` without plaintext and a recipient decrypts it, but that harness was not run for this review.
13. **How does history recovery work?** A new device has a separate crypto store; old room keys require a trusted server backup and the user’s recovery key. Recovery is implemented but not live-verified here.
14. **Can I claim 10,000 users?** No. Registered users, concurrent sync clients, and message throughput differ; there is no benchmark or load result.
15. **What comes before production?** Enforce tenant/plan policy at the Matrix boundary, implement session/device restoration, secure deployment secrets and HTTPS, add encrypted media or keep it disabled, instrument/backup the system, and run security and load testing.

## Core file responsibilities

- **Backend entry and routes:** `backend/app/main.py`, `backend/app/api/v1/{auth,users,profiles,subscriptions,access}.py`.
- **Data and business rules:** `backend/app/models/`, `backend/app/repositories/`, `backend/app/services/`, `backend/app/core/{security,permissions,database,config}.py`.
- **Matrix bridge:** `backend/app/integrations/matrix/client.py` and `backend/app/core/security.py`.
- **React state:** `frontend/src/App.tsx`, `frontend/src/context/{AuthContext,MatrixContext}.tsx`, `frontend/src/hooks/useMatrixRooms.ts`.
- **Matrix client:** `frontend/src/services/matrix/{client,session,crypto-store,secret-storage,identity,encryption,rooms,events}.ts`.
- **Chat UI:** `frontend/src/pages/ChatPage.tsx`, `frontend/src/components/MatrixSecurityDialog.tsx`, and `frontend/src/components/chat/`.
- **Infrastructure:** `compose.backend.yaml`, `compose.synapse.yaml`, local `synapse/config/homeserver.yaml`, and environment templates.

## Security concepts to remember

- Keep the FastAPI JWT, server-only Synapse login assertion, and Matrix access token distinct.
- `users.organization_id` controls FastAPI directory visibility; Matrix room membership is a separate Synapse policy.
- The browser encrypts message bodies before they reach Synapse. The homeserver still sees room/event metadata.
- Cross-signing/device verification establishes trust; an encrypted room alone does not verify a contact’s identity.
- A recovery key unlocks recovery material; the homeserver key backup contains encrypted room keys. Never reveal the recovery key.
- Device compromise, malicious browser code, account takeover, metadata exposure, and unencrypted attachments remain risks.
- Never expose the ignored local Synapse config, `.env`, tokens, passwords, or private keys in an interview.

## Main implementation limitations

- Step 08 direct-message changes and the browser harness are committed in `d0ed3a0`; the browser scenario was not run for this review.
- A fresh `npm test` passed 6 files / 33 tests; `npm run typecheck` passed. Backend, live Synapse/E2EE, browser, and load tests were not run.
- Registration does not assign an organization; two unassigned users cannot discover each other in the directory.
- Subscription checks are illustrative and do not gate all chat or Matrix room actions.
- The app does not restore its in-memory login on browser refresh; a later login receives a new Matrix device context.
- Encrypted file upload/media is not implemented; live attachments are disabled.
- Group-room creation exists in a hook/test path, but there is no visible group-creation flow.
- Step 08 source submits Matrix read receipts, but there is no explicit `m.fully_read` marker call; the architecture doc’s read-marker limitation remains consistent. Live receipt behavior is unverified.
- There is no proven 10k/500-user capacity, production security audit, monitoring/alerting stack, or documented restore drill.

## Final interview revision checklist

- [ ] Explain the two database ownership boundaries and draw the browser → FastAPI/Synapse flow.
- [ ] State the exact schema: nullable user organization FK, one-to-one profile, per-user subscription; no Subscriber or membership table.
- [ ] Trace app password → bridge JWT → Synapse token → browser Matrix SDK.
- [ ] Describe room creation, invite acceptance, encrypted send, sync, and recipient decryption.
- [ ] Separate unit-test evidence from unrun live/browser harnesses.
- [ ] Explain device verification, cross-signing, recovery key, encrypted backup, and metadata limits.
- [ ] Be candid that Step 08 is committed but not live-verified, and that group UI, encrypted media, session restoration, tenant-to-Matrix enforcement, and capacity proof are incomplete.
- [ ] Do not claim the app is production-ready or supports 10,000 active users without new evidence.
