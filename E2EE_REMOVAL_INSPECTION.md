# E2EE removal inspection (no implementation)

This is a source/configuration review, not a live room inventory or a migration. **Confirmed** means directly visible in the checked-in code. **Proposed** means a future implementation choice. No rooms, messages, media, devices, keys, or code were changed for this report. The actual number of encrypted rooms and decryptable historical events cannot be verified from source alone.

## 1. Current encryption architecture

```text
React + matrix-js-sdk (browser)
  | app login / contacts                    | Matrix sync, rooms, messages, media
  v                                         v
FastAPI -> app PostgreSQL          Synapse -> Synapse PostgreSQL + media volume
     \--- short-lived JWT login to Synapse ---/
                    browser Rust crypto + IndexedDB keys
```

**Confirmed.** React/TypeScript/Vite uses `matrix-js-sdk` 44.0.0 (`frontend/package.json`). FastAPI owns app users, password hashes, refresh sessions, contacts, and subscriptions (`backend/app/api/v1/`, `backend/app/services/`, `backend/alembic/versions/`). It does not implement chat message storage. Synapse owns Matrix rooms/events and uses a separate PostgreSQL database and `synapse_media` volume (`compose.synapse.yaml`). The app backend reaches Synapse at `http://synapse:8008` on a shared Docker network (`compose.backend.yaml`); browser URLs are configured in `frontend/.env.example`. The two Compose files define four services: `backend`, `app-postgres`, `synapse`, and `postgres`. The frontend is not a Compose service here. `scripts/setup/configure-synapse.py` enables Synapse JWT login and disables public Synapse registration; it does not mandate encryption globally.

**Confirmed.** FastAPI login and Matrix login are separate from message encryption. `backend/app/api/v1/auth.py:login/restore/logout` and `backend/app/integrations/matrix/client.py:MatrixClient` issue/validate/revoke a Matrix access token via Synapse. `backend/app/core/security.py:create_synapse_login_token` creates the login JWT. No E2EE key is part of those backend credentials. The browser receives the Matrix user/device/token, creates an SDK client (`frontend/src/services/matrix/client.ts:createAuthenticatedMatrixClient`), verifies identity, initializes Rust crypto in IndexedDB, and starts sync (`frontend/src/services/matrix/session.ts:MatrixClientSession.initialize`, lines 1145–1220).

**Confirmed.** Every new room created by the application takes the `createEncryptedRoom` path. That function sets `m.room.encryption` in `createRoom.initial_state` with Megolm, then checks the room and SDK encryption state (`frontend/src/services/matrix/encryption.ts:17–92`). Direct-room reuse also requires `hasEncryptionStateEvent()` (`frontend/src/hooks/useMatrixRooms.ts:68–86`). Group creation calls the same helper (`useMatrixRooms.ts:99–147`). Existing rooms are detected with `room.hasEncryptionStateEvent()` (`frontend/src/services/matrix/rooms.ts:126–209`); plaintext rooms are currently shown but sending is blocked (`frontend/src/pages/ChatPage.tsx:760–765, 1135–1179`). No application call to `setRoomEncryption` was found.

## 2. Affected files and functions

| File | Function / area | Purpose and removal dependency |
| --- | --- | --- |
| `frontend/src/services/matrix/session.ts` | `MatrixClientSession.initialize` (1145–1220), `checkCryptoOnboarding` (655–805), `refreshCryptoStatus` (810–845) | Acquires crypto-store lock, initializes Rust crypto/IndexedDB, sets signed-device isolation, checks cross-signing/backup, then starts sync. A plaintext-only client must still start sync and handle auth/reconnect without these gates. |
| `frontend/src/services/matrix/session.ts` | `restoreFromRecoveryKey` (477–545), verification methods (554–625), `watchForDecryption` (991–1005), crypto listeners (1081–1136) | Recovery, device list, SAS verification, and decrypted-event refresh. Old encrypted history needs these until an archive/compatibility plan is complete. |
| `frontend/src/services/matrix/session.ts` | `acknowledgeDecryptedMessage` (355–398), `acceptDeliveryAcknowledgment` (407–443) | Direct-chat **delivered** status uses encrypted to-device messages and checks encrypted original events. Removing crypto removes this status mechanism unless replaced. |
| `frontend/src/services/matrix/crypto-store.ts` | `matrixCryptoStoreIdentity`, `acquireMatrixCryptoStoreLock` (1–end) | Namespaces the Rust IndexedDB store by homeserver/user/device and locks it across tabs. Preserve existing stores/keys during rollout and rollback. |
| `frontend/src/services/matrix/secret-storage.ts` | `SecretStorageKeyController` (13–end) | Holds recovery material in memory for cross-signing and key backup. Needed to recover old ciphertext. |
| `frontend/src/services/matrix/client.ts` | `createAuthenticatedMatrixClient` (94–125), `verifyMatrixClientIdentity` (128–151) | Creates SDK client with a memory timeline store, Matrix credentials, and SAS/crypto callbacks; identity validation remains useful without E2EE. |
| `frontend/src/services/matrix/encryption.ts` | `createEncryptedRoom` (17–92), `acceptEncryptedGroupInvitation` (95–132), `sendEncryptedTextMessage` (145–158), `assertEncryptedSendReady` (160–211) | Creates encrypted direct/group rooms, checks crypto on group join, and refuses plaintext sending. These are the main new-room/send boundaries to redesign. Group/direct marker constants (5–8) are metadata, not encryption themselves. |
| `frontend/src/hooks/useMatrixRooms.ts` | `createDirect` (57–98), `createGroup` (99–148) | Requires crypto readiness, searches only encrypted direct rooms, and calls encrypted room creation. A migration must avoid silently reusing old encrypted rooms as plaintext. |
| `frontend/src/context/MatrixContext.tsx` | `MatrixProvider` (51–171) | Starts managed SDK session and exposes crypto state; new-account onboarding completion depends on cross-signing readiness (130–146). |
| `frontend/src/context/AuthContext.tsx` | `register` (150–165), `completeNewAccountCryptoSetup` (167–176), `signIn` (126–148), `signOut` (178–200) | Registration sets a sessionStorage crypto-onboarding marker; app/Matrix login and logout should remain. Do not conflate removing onboarding with removing Matrix login. |
| `frontend/src/pages/ChatPage.tsx` | Direct provisioning (253–310), send permissions (335–370), receipt effect (675–707), invitations (719–754), `sendMessage` (756–835), composer (1121–1182) | Creates encrypted direct rooms, checks encrypted event permissions and crypto readiness, sends text/files, handles group joins and read receipts. Plaintext behavior needs deliberate permission and room-type checks. |
| `frontend/src/services/matrix/rooms.ts` | `timelineMessages` (53–115), `conversationFromMatrixRoom` (126–210), `conversationsFromMatrixClient` (213–222) | Discovers joined/invited rooms from SDK state; classifies groups using marker/member count; derives `isEncrypted`, room ID, member metadata, messages, receipts. Must keep old rooms distinguishable. |
| `frontend/src/services/matrix/events.ts` | `messageFromMatrixEvent` (36–133) | Maps plaintext `m.room.message` and decrypted `m.room.encrypted`; without crypto, old ciphertext becomes a placeholder and its reply/attachment content is unavailable. |
| `frontend/src/services/matrix/messageNavigation.ts` | `loadMatrixMessagePreview` (83–103), `loadMatrixMessage` (110–155) | Fetches/paginates exact historical events and calls `decryptEventIfNeeded` (40–45). Old encrypted history needs crypto or a separately authorized archive. |
| `frontend/src/services/matrix/attachments.ts` | `validateAttachment` (13–31), `sendAttachment` (34–54) | Already uploads the original file bytes via `uploadContent`; only the room message containing its `mxc://` URI is encrypted. Validation and upload can remain, but old encrypted file-message metadata will be unreadable without keys. |
| `frontend/src/services/matrix/media.ts` | `fetchMatrixMedia` (10–37) | Bearer-authenticated Synapse media download; no file decryption is implemented here. |
| `frontend/src/components/MatrixSecurityDialog.tsx` | `MatrixSecurityDialog` (35–end) | Device lists, SAS verification, recovery, and backup UI. Must remain available for old-history access until the migration/retention decision is complete. |
| `frontend/src/components/MatrixConnectionStatus.tsx` | status labels (21–65) | Presents crypto readiness/recovery status. |
| `frontend/src/components/chat/ChatHeader.tsx` | `ChatHeader` (38–end) | Displays encryption lock and status text. |
| `frontend/src/components/chat/ConversationSidebar.tsx` | `ConversationSidebar` (current crypto props, 36–60, 275–276) | Passes crypto status to sidebar connection indicator. |
| `frontend/src/types/matrix.ts` | crypto/backup/verification types | Types the session and security UI states. |
| `frontend/src/types/index.ts` | `Conversation.isEncrypted`, `Message.matrix` | Models room type and encrypted-event state; room ID remains the Matrix ID. |
| `frontend/src/components/chat/AttachmentCard.tsx`, `frontend/src/components/UserAvatar.tsx` | media rendering | Use `fetchMatrixMedia`; old encrypted event metadata is needed to discover an attachment URI, while avatar media is separate. |
| `frontend/src/services/matrix/pinning.ts` | pinned event IDs | Room state references event IDs; links to old encrypted events need old-history access or a fallback. |
| `frontend/src/services/matrix/identity.ts` | `matrixUserIdForAppUserId` | Stable Matrix identity mapping; preserve this across replacement rooms. |
| `backend/app/api/v1/auth.py`, `backend/app/integrations/matrix/client.py`, `backend/app/core/security.py`, `backend/app/core/matrix_session_cookie.py` | login/session functions | Matrix authentication, not E2EE. Keep unless changing the entire chat identity system. |
| `scripts/setup/configure-synapse.py`, `synapse/templates/homeserver.yaml.example`, `compose.synapse.yaml`, `compose.backend.yaml` | Synapse JWT, storage, networks | No room-encryption switch to remove; keep server/database/media and credentials. |

**Tests and dependencies.** `frontend/src/services/matrix/{session,crypto-store,encryption,events,rooms,messageNavigation,attachments,client}.test.*`, `frontend/src/hooks/useMatrixRooms.test.ts`, and `frontend/src/components/chat/{MessageList,MessageBubble,NewConversationDialog}.test.tsx` cover relevant pieces. `frontend/scripts/matrix-e2ee-live-test.mjs`, `matrix-e2ee-browser-test.mjs`, and `matrix-step08-browser-test.mjs` assert encrypted wire events, SAS/recovery, and browser flows. They must be replaced or split into plaintext and legacy-history checks, not simply deleted. The `matrix-js-sdk` dependency remains required for Matrix messaging; removing E2EE does not mean removing the SDK. No separate E2EE package is declared in `frontend/package.json`.

## 3. Effects if crypto were simply removed today

| Feature | Confirmed current behavior | Effect of an immediate crypto removal |
| --- | --- | --- |
| Registration and JWT login | App account is created in FastAPI; FastAPI obtains a Matrix token through Synapse JWT login. | Can remain, but new-account crypto-onboarding marker/UI must stop blocking chat. Existing Matrix login is still required. |
| One-to-one messaging | Accepted contacts trigger encrypted direct-room provisioning; both members and encrypted send permission are checked. | Existing direct rooms stay encrypted; current `ChatPage` refuses plaintext rooms. A new plaintext-room creation/reuse/send path is needed. |
| Groups/invitations | `createEncryptedRoom` invites members; accepting group invites requires encryption readiness. | New plaintext groups need a different creation/join path. Existing encrypted invites still require old-capable clients or an explicit decline/legacy policy. |
| Send/receive | SDK encrypts messages in encrypted rooms; `events.ts` handles ciphertext and decrypted clear content. | New plaintext rooms can use `m.room.message`, but old ciphertext cannot be read by a no-crypto client. Do not send plaintext into old encrypted rooms. |
| History/pagination | SDK sync starts with `initialSyncLimit: 30`; room view uses recent timeline; `messageNavigation.ts` can fetch/paginate exact older events and decrypt. | Plaintext history remains readable in new rooms. Old encrypted events fetched from Synapse still require keys and a crypto-capable client. |
| Replies/quotes | `m.relates_to.m.in_reply_to.event_id` points to an event in the same room; room mapping resolves quoted text if available. | Replies work within new plaintext rooms after send guards change. Old event IDs do not identify events in a replacement room; cross-room quote copying needs an explicit new representation. |
| Images/PDFs/docs | Original bytes are uploaded to Synapse media; encrypted message holds the URI/name/type. | New plaintext file messages expose name/URI/metadata to Synapse and room members. Old file bytes may remain in media, but locating them from an encrypted event requires decryption. |
| Typing/read receipts | `MessageComposer` uses SDK `sendTyping`; `ChatPage` uses `sendReadReceipt`; room mapping reads receipts. | These Matrix features can survive. Encrypted-event-specific receipt predicates need updates. Direct **delivered** ticks rely on encrypted to-device acknowledgments and would be lost unless redesigned. |
| Logout/login recovery | App and Matrix sessions are managed by `AuthContext`; crypto keys are in browser IndexedDB and optional Matrix backup. | Login/logout remain, but old history on a new device loses recovery if crypto/recovery UI and key access are removed. |
| Existing encrypted rooms | Detected by `hasEncryptionStateEvent()`; current UI blocks plaintext sends. | They cannot be converted in place to unencrypted rooms. A replacement room has a new ID and separate history. |

## 4. Existing-room discovery and migration strategy

**Confirmed from code.** Room IDs are Synapse-generated (`createEncryptedRoom` returns `result.room_id`). The frontend routes to `/chat/{roomId}` (`frontend/src/pages/ChatPage.tsx:createGroup`) and reads rooms from `client.getRooms()` (`session.ts:readRooms`, `rooms.ts:conversationsFromMatrixClient`). It derives names, group marker, members, encryption flag, messages, and last activity from Matrix room state/timeline (`rooms.ts:126–222`). There is no application database table for room IDs or a durable old-to-new-room mapping in the Alembic migrations. Browser localStorage in `session.ts` holds a limited set of delivery-ack event IDs, not a room registry. Group membership lives in Synapse, not app PostgreSQL. Actual room inventory, per-room history visibility, member states, key backup coverage, and whether every participant can decrypt every event are **unverified**.

**Proposed safe migration:**

1. Inventory encrypted rooms through authorized Matrix clients or a read-only administrative report: room ID, direct/group marker, membership and invitations, current room name/avatar/topic, power levels, encryption state, history visibility, and event counts. Do not log plaintext or keys during inventory. Check who can still decrypt representative old events and whether backup/recovery works.
2. Preserve Synapse PostgreSQL, media volume, client IndexedDB crypto stores, and available key backups before rollout. Snapshot and restore procedures must be tested. Never strip `m.room.encryption` from an existing room or send plaintext into it.
3. Create **new** private, unencrypted rooms. Preserve the stable Matrix user IDs, intended room type, name, and current eligible invitees. Reconcile actual Matrix membership and app accepted-contact policy; invited users are not yet joined members. Matrix permissions may prevent an ordinary client from inviting everyone or copying some state; test those cases. The new room receives a new ID.
4. Add a durable, access-controlled old-room/new-room mapping or explicit transition state. Avoid duplicate replacement rooms on retries and concurrent clients. Preserve old rooms as read-only legacy rooms in the UI, with a visible link to the new conversation. The current app has no mapping storage or migration API, so this requires new design and code.
5. Decide historical-content policy **before** moving anything. Safest default is to leave encrypted history in its old room and keep a legacy-capable reader/recovery path. Copying decrypted history into plaintext is a confidentiality change: only do it with an explicit authorization policy, participant notice/consent as appropriate, verified room access, provenance labels, and an audit trail. A normal client cannot recreate original sender identities, event IDs, timestamps, signatures, read receipts, and reply targets in a new room exactly. Missing keys, redactions, inaccessible events, and users who joined later can make some history permanently unavailable to a given device. Media from old encrypted event metadata has the same dependency.
6. Keep old crypto support available until the retention/export policy is satisfied. A new plaintext-only client would show placeholders for old ciphertext, including reply text and attachment metadata. Removing IndexedDB or server key backups would make rollback and recovery harder or impossible.

## 5. Risks and breaking changes

- **Confidentiality change:** all new plaintext `m.room.message` content, filenames, and file URIs can be processed by Synapse. Existing attachment bytes are already uploaded without file-level encryption (`attachments.ts:41`), but their event metadata is currently inside encrypted room messages.
- **Irreversible room type:** Matrix encryption state is part of the room's state/history. The current app treats it as a one-way property. Replacement rooms are required.
- **History loss in the UI:** removing `initRustCrypto`, keys, and recovery breaks access to old `m.room.encrypted` events. Synapse stores ciphertext, not plaintext it can restore for users.
- **Mixed-client rollout:** older clients may keep creating encrypted rooms or send to old ones while newer clients prefer plaintext. A rollout needs an explicit room-type policy, version coordination, and duplicate-room prevention.
- **Policy drift:** accepted-contact checks are in `ChatPage`/hooks, while Matrix clients can also call Synapse directly. A new room migration must not assume React checks are server authorization.
- **Delivery status regression:** the encrypted to-device acknowledgment in `session.ts` does not transfer automatically to plaintext messaging.
- **Route/reference regression:** old room URLs, pinned event IDs, replies, and media references point to old IDs. A replacement room cannot transparently inherit them.
- **Verification wording:** security indicators and onboarding text become misleading if left unchanged; tests expecting encrypted wire types will fail for an intended reason.

## 6. Recommended implementation order (future work)

1. Define the privacy/history decision and acceptance criteria: preserve old encrypted rooms read-only, or authorize a controlled export. Establish an inventory and backup/restore gate first.
2. Design room classification and durable transition mapping. Keep `isEncrypted` and old/new room IDs explicit in `rooms.ts`, `types/index.ts`, and any new backend mapping API/storage. Do not reuse encrypted rooms for plaintext conversations.
3. Add a new plaintext room creator/joiner in `frontend/src/services/matrix/` and update `useMatrixRooms.ts` and `ChatPage.tsx` provisioning for direct and group rooms. Retain stable Matrix user IDs and group marker behavior.
4. Add a plaintext send path and change permission checks to the appropriate `m.room.message` event type. Keep membership, accepted-contact, and reply-event validation. Update attachment sending only after the privacy decision is reflected in the UI/product policy.
5. Split the Matrix session into ordinary sync and optional legacy crypto access. Remove crypto readiness as a gate for *new plaintext* rooms while preserving a path to decrypt old rooms. Update `MatrixContext`, `AuthContext`, security UI, connection status, header, and composer text together.
6. Update receiving, read-receipt, reply, history, pin, and delivery-status logic for mixed old/new room types. Decide whether to replace the encrypted delivered acknowledgment or remove that UI claim.
7. Introduce replacement rooms with idempotent mapping, invitations, clear transition UI, and monitoring. Migrate users in stages. Keep old rooms and keys intact.
8. After old-history access and rollback requirements expire by explicit decision, simplify crypto code and tests. Do not remove the Matrix SDK or Synapse JWT login merely because E2EE is removed.

## 7. Testing and rollback plan (future work)

- **Before rollout:** restore a snapshot in an isolated environment; verify old-room decryption on existing and recovered devices, room membership, and media retrieval. Inventory actual encrypted rooms and backup coverage.
- **Automated checks:** unit tests for plaintext room creation/reuse, mixed-room classification, membership/permissions, plaintext send/receive, replies, attachments, pagination, typing, receipts, and duplicate-transition prevention. Keep a legacy encrypted-room read test. Run TypeScript checks and one frontend build, then relevant backend tests if mapping/API changes are added.
- **End-to-end checks:** two users in a direct room and three in a group; new plaintext wire event type; no `m.room.encryption` in new rooms; old encrypted room still decrypts with keys; new-device history behavior; logout/login; file upload/download; old/new links. Test with mixed client versions and interrupted migration.
- **Rollback:** retain the old client build and crypto support, Synapse/app database snapshots, media volume, and key material. Stop creating replacement rooms if errors rise; do not delete new rooms or old rooms automatically. A rollback can restore old-room access only if keys and backups remain. Plaintext messages already sent in new rooms cannot be made confidential retroactively.

**Unverified:** live room counts, real encryption-key availability, Synapse's current generated `homeserver.yaml` (ignored by Git), production TLS/reverse proxy settings, and whether external Matrix clients use these rooms. These need authorized read-only runtime inspection before any migration is approved.
