# Chat simplification result

Removed E2EE from the React client, retired old encrypted rooms in the UI, and
replaced the interface with a two-panel plaintext chat. Backend, Docker, Synapse
configuration and databases were not modified.

## Architecture (frontend)

| Layer | Files |
| --- | --- |
| Auth | `context/AuthContext.tsx` (login, register, restore, logout; demo mode and crypto-onboarding marker removed) |
| Matrix services | `services/matrix/client.ts` (client + identity check), `session.ts` (sync lifecycle, reconnect, auth failure), `messaging.ts` (plaintext room creation, invites, send, retired-room detection), `rooms.ts`, `events.ts`, `messageNavigation.ts`, `attachments.ts`, `media.ts`, `pinning.ts` |
| Hooks | `useMatrixRooms` (create/reuse direct and group rooms), `useConnections` (FastAPI contacts/requests), `useReadReceipts`, `usePinnedMessages` |
| UI | `pages/ChatPage.tsx` (orchestration), `ConversationSidebar`, `ChatHeader`, `MessageList`, `MessageBubble`, `MessageComposer`, `NewConversationDialog`, `ConnectionBanner`; styles in `styles/layout.css` (new shell) on top of the pruned `chat.css` |

## E2EE removed

- `initRustCrypto`, IndexedDB crypto store and cross-tab lock, secret storage, recovery key restore, key backup, cross-signing, device list, SAS verification, crypto onboarding, crypto-readiness gates, and the encrypted to-device delivery acknowledgement are gone from `session.ts`, `client.ts`, `MatrixContext`, `AuthContext`, `ChatPage` and the hooks.
- Deleted: `encryption.ts`, `crypto-store.ts`, `secret-storage.ts` (+ tests), `MatrixSecurityDialog.tsx`, `MatrixConnectionStatus.tsx`, `types/matrix.ts`, `scripts/matrix-e2ee-*.mjs`, `scripts/matrix-step08-browser-test.mjs`, the two `test:e2ee-*` npm scripts. The Matrix SDK itself is still used.
- New rooms are created with no `m.room.encryption` state. Messages are standard `m.room.message` events.
- The "delivered" tick was removed (it relied on encrypted to-device messages). No replacement was built, so none is shown. "Sent" and "Read" remain.

## Old encrypted conversations

- **Hidden:** any joined or invited room with an `m.room.encryption` state event is excluded from the conversation list. Their IDs (only) are exposed as `legacyRoomIds` in the Matrix snapshot for inventory.
- **Never reused or written to:** direct-room reuse ignores them (a fresh plaintext room is created), sending and accepting invites to them is refused, and their ciphertext is never rendered. No history was migrated.
- **Fresh rooms:** the requester of each accepted connection auto-creates a new plaintext direct room (as before); groups are created plaintext.
- **Not deleted.** No server-side deletion was executed. Old rooms and history still exist in Synapse and users remain members. **Do not describe the old messages as deleted.**

### Supported deletion procedure (not run)

`scripts/admin/retire-encrypted-rooms.py` uses the Synapse Admin API (`GET /_synapse/admin/v1/rooms`, `DELETE /_synapse/admin/v2/rooms/{id}` with `purge`):

1. Snapshot the Synapse database and `synapse_media` volume.
2. `SYNAPSE_ADMIN_TOKEN=… ./scripts/admin/retire-encrypted-rooms.py inventory --output inv.json` (read-only; room IDs and metadata only).
3. Review `inv.json`; then `delete --inventory inv.json` (dry run by default).
4. Only with separate authorization: `delete --inventory inv.json --execute --confirm "DELETE <N> ENCRYPTED ROOMS"`. Each room is re-checked as encrypted immediately before deletion; plaintext rooms are skipped.
5. Room deletion does **not** remove uploaded media; handle that with the media admin API after review. Verify completion via Synapse's room-deletion status API.

Verified against a local mock server only (inventory, dry run, wrong confirmation refused, only the encrypted room deleted). Not run against a real Synapse.

Browsers still hold old Rust-crypto IndexedDB stores; they are unused and were left in place (rollback). Users can clear site data.

## UI/UX changes

- Desktop: left sidebar (logo, new chat, create group, profile with log out, search, connection requests, **Direct messages** and **Groups** lists) and right chat panel (header with avatar/name/typing, messages, reply previews, attachment cards, timestamps, read ticks, composer with attach and send).
- Mobile (<768px): conversation list first, chat full-screen, back button.
- Removed: demo mode, security/devices dialog, encryption indicators, contact-info side panel (mute/wallpaper/starred placeholders), message-search row, header menus, ~1,200 lines of dead CSS.
- Kept: message pinning, emoji picker, connection-request flow.
- Presence: not requested from Synapse, so no online/offline indicator is shown.
- Login/Register pages are unchanged apart from removing the demo link ("Continue with Google" is still the pre-existing non-functional placeholder).

## Preserved

Registration, login, logout, JWT/Matrix session restore; user accounts, contacts and subscriptions (backend untouched); direct and group chat, invitations, replies, history and pagination, attachments (Matrix media storage unchanged), read receipts, typing, unread counts, duplicate-direct-room prevention (shared in-flight creation plus reuse of an existing plaintext room), server-side re-check of accepted contacts before direct send and group creation.

## Verification (run in this session)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | pass |
| `vitest run` (frontend, 19 files) | **106 passed, 0 failed** |
| `npm run build` | pass (existing chunk-size and dynamic-import warnings) |
| Backend tests | not run: no backend file changed |

New or rewritten tests: `messaging.test.ts` (plaintext room creation without encryption state, direct/group, validation, send, reply, permission, retired-room refusal, invitations), `session.test.tsx` (sync without any crypto call, room publishing, retired-room exclusion, reconnect, auth failure, identity mismatch, dispose, registry), `rooms.test.ts` (retired-room exclusion and ID inventory), `useMatrixRooms.test.ts` (no reuse of encrypted rooms, reuse of plaintext rooms, in-flight sharing), `events.test.ts`, `messageNavigation.test.ts`, `ChatHeader.test.tsx`, `ConversationSidebar.test.tsx`. Existing tests for attachments, reply, composer, message list and bubble still pass.

## Not verified / limitations

- **No real multi-client or browser run.** Nothing was exercised against a live Synapse and FastAPI stack: real-time delivery between two users, read receipts and typing across clients, group invitations end to end, media upload/download, and session restore are covered by unit tests with mocked clients only. `scripts/matrix-live-test.mjs` was not run.
- **No visual check.** The new layout and CSS were typechecked and built but not viewed in a browser at desktop or mobile widths. Review `styles/layout.css` and the remaining `chat.css` in a browser before release.
- Auto-created direct rooms are still made by the requester only. If a contact's old room is hidden but the requester never logs in again, no new room appears until they do.
- `legacyRoomIds` is exposed but not shown in any UI.
- Docs other than `docs/end-to-end-encryption.md` (README, architecture, matrix integration) still describe E2EE and need a follow-up.
- Old users remain members of retired rooms and still receive their invites until the admin deletion is run.

## Security and privacy

- Synapse and its admins can read all new message bodies, file names and media URIs. Existing media bytes were already uploaded unencrypted.
- Authorization is unchanged: JWT/Matrix identity check on connect, accepted-contact re-check on the server before direct send and group creation, Matrix power levels checked for `m.room.message`.
- Retired rooms are blocked from send and join in the client only; the client is not a server-side control. Deleting them with the admin tool is the real fix.

## Rollback

`git revert` the commit (or `git checkout 108e404 -- frontend docs scripts`) and rebuild. Old rooms still exist and browser crypto stores were not deleted, so the previous client can read old history. Plaintext messages already sent cannot be made confidential again, and new plaintext rooms stay plaintext.
