# Matrix End-to-End Encryption

LumaChat uses the official Matrix JavaScript SDK and its Rust/WASM crypto
implementation for live encrypted text messaging. The frontend does not
implement encryption algorithms. Synapse routes Matrix events and stores
encrypted message events; it does not receive the message body used by the
SDK to produce those events.

## Versions and SDK initialization

The frontend pins `matrix-js-sdk` to `44.0.0` in `frontend/package.json` and
`package-lock.json`. As checked on 2026-10-27, the official release list shows
v44.0.0 as the latest stable release and v45.0.0-rc.0 as a prerelease. Version
44.0.0 includes `@matrix-org/matrix-sdk-crypto-wasm` `18.9.0` and supports
Node.js 22. See the [official SDK releases](https://github.com/matrix-org/matrix-js-sdk/releases)
and [v44.0.0 notes](https://github.com/matrix-org/matrix-js-sdk/releases/tag/v44.0.0).

After FastAPI login, the existing response supplies the Matrix access token,
user ID, device ID, and homeserver metadata. The React Matrix session manager
checks the expected Matrix ID and calls Synapse `whoami` before initializing
Rust crypto. It awaits `client.initRustCrypto()` and confirms `client.getCrypto()`
is available before starting `startClient()`. The UI reports initial sync only
after the SDK emits `SyncState.Prepared`.

Crypto is initialized once per managed client. `MatrixClientRegistry` reuses a
client across React StrictMode remounts. A Web Lock holds one active client per
crypto-store identity; a second tab using the same device fails closed. There
is no legacy-crypto initialization or plaintext-send fallback.

## Device identity and browser storage

Rust crypto uses the SDK's IndexedDB-backed store. LumaChat names the store
using a SHA-256 namespace derived from the normalized homeserver URL, Matrix
user ID, and Matrix device ID. This digest only isolates store names; it is
not a key or a substitute for the SDK's cryptography. Browser synchronization
state remains in memory.

The application JWT and Matrix access token stay in React/application memory;
neither is written to localStorage or sessionStorage. Private crypto state
stays in the SDK's IndexedDB store. Logout stops the Matrix client, removes
listeners, clears in-memory secret-storage callbacks, and asks FastAPI to
revoke the Matrix session. It does not delete the IndexedDB crypto store.

The current FastAPI flow issues a new Matrix device session on each login and
does not restore a previous Matrix access token after a browser reload. The
user must sign in again, and the new device receives a separate crypto-store
namespace. The old device store is not reused or deleted. Encrypted history
on the new device requires a trusted Matrix key backup and the user's recovery
key. Clearing browser site data can remove the local device store; recovery
then depends on the encrypted backup and recovery key.

## Encrypted rooms and messages

New direct rooms are private and created with the
`m.room.encryption` state event (`m.megolm.v1.aes-sha2`) in the initial room
state. The SDK and Synapse encryption state are both checked before the room
is treated as encrypted. The shared room service supports encrypted group
creation as well. Existing plaintext rooms are not converted automatically;
the live composer refuses to send in them. Create a new encrypted room when
the conversation must be end-to-end encrypted.

The strict signed-device policy requires users to establish cross-signing and
verify devices before they are treated as trusted. An untrusted sender may
therefore remain unreadable, and a send that cannot safely distribute a room
key fails through the SDK. The app never retries that message as plaintext.

For live text sends, the React composer calls the guarded Matrix room service.
That service verifies Rust crypto readiness, the room's encryption state, and
the SDK's encryption state before calling `MatrixClient.sendTextMessage()`.
The Matrix SDK encrypts locally and distributes room keys to eligible devices.
Receivers get `m.room.encrypted` timeline events; Rust crypto decrypts them,
and the React room model refreshes when the SDK reports decryption. Pending
events do not expose ciphertext in message bubbles. Failed decryption displays
a sanitized error.

The composer does not enable live file attachments. Encrypted attachment
upload/download through Matrix's encrypted-media flow is not implemented, and
LumaChat does not claim that attachments are encrypted.

## Cross-signing and verification

Cross-signing and secret storage are initialized through the Rust crypto
`CryptoApi`. Users explicitly start recovery setup in **Encryption and
devices**. LumaChat checks that secret storage and a backup do not already
exist, generates a recovery key locally, displays it for the user to save,
and waits for acknowledgement. It then calls the supported
`bootstrapSecretStorage()` and `bootstrapCrossSigning()` APIs and enables a
trusted key backup. Existing backup or secret-storage state is left intact.

The SDK manages device keys and one-time keys. LumaChat displays device IDs,
public fingerprints, signed-by-owner status, cross-signing status, and actual
device verification state from the SDK. Unknown devices are not marked
verified automatically. Peer verification uses the SDK's in-room
`requestVerificationDM()` flow in a joined one-to-one room; verification of
another device owned by the current user uses the device-verification flow.
Both sides must compare the SDK-provided SAS emoji and explicitly confirm a
match. Cancellation and failure remain visible states.

Encryption and identity verification are different claims: an encrypted room
does not mean the contact's identity has been verified. A device is shown as
verified only when the Rust crypto API reports that trust state.

## Encrypted backup and history recovery

Matrix key backup stores encrypted room keys on Synapse. LumaChat checks
backup trust using the SDK and does not treat an untrusted backup as usable.
The recovery key is never sent to FastAPI, logged, or persisted by LumaChat.
The SDK encrypts cross-signing secrets and the backup decryption key in Matrix
secret storage. The secret-storage callback keeps key bytes in memory and
clears them when the client is disposed.

On a new device, the user enters the recovery key in **Encryption and
devices**. Rust crypto validates access to secret storage and the trusted
backup, loads the backup decryption key, restores room keys, and retries
decryption of historical events. A valid-looking but wrong recovery key,
missing backup, or damaged/unavailable server backup can prevent restoration.
Losing every copy of a room key and recovery key can make the corresponding
history permanently unreadable.

An uploaded backup is not proof that recovery works. The live test creates a
fresh Matrix device with an isolated crypto store, verifies that it initially
cannot decrypt an old event, restores room keys from the recovery key, and
checks that the historical body decrypts afterward.

## Trust and metadata

Rust crypto is configured with the SDK's `OnlySignedDevicesIsolationMode`.
This is the SDK's device-isolation policy, not an assertion that every contact
has been interactively verified. LumaChat does not mark unknown devices
trusted or fall back to sending plaintext if encryption fails.

E2EE protects message content. It does not hide all metadata, including room
membership, sender/device information, room state not encrypted by Matrix,
event timing, or routing. FastAPI does not proxy Matrix message bodies.
Encrypted attachments, full device-management UX, persistent account/device
session restoration, and broader recovery/key migration are outside this step.

## Implemented message flow

This sequence follows the current React session manager, FastAPI login
response, Matrix SDK client, and message composer:

```mermaid
sequenceDiagram
    autonumber
    actor UserA as User A
    participant ReactA as React application
    participant SDK_A as Matrix SDK + Rust crypto A
    participant FastAPI
    participant Synapse
    participant SDK_B as Matrix SDK + Rust crypto B
    participant ReactB as React application B
    actor UserB as User B

    UserA->>ReactA: Submit app username and password
    ReactA->>FastAPI: POST /auth/login
    FastAPI->>Synapse: Exchange short-lived server JWT
    Synapse-->>FastAPI: Matrix access token, user ID, device ID
    FastAPI-->>ReactA: App JWT and Matrix session
    ReactA->>SDK_A: Create client and validate whoami identity
    SDK_A->>SDK_A: initRustCrypto() with isolated IndexedDB store
    SDK_A->>Synapse: startClient() and initial /sync
    Synapse-->>SDK_A: PREPARED sync state and joined rooms

    UserA->>ReactA: Start an encrypted conversation
    ReactA->>SDK_A: createRoom(initial_state includes m.room.encryption)
    SDK_A->>Synapse: Create private room and invite recipient
    Synapse-->>SDK_A: Room ID and encrypted room state
    UserA->>ReactA: Compose text
    ReactA->>SDK_A: sendTextMessage(roomId, body)
    SDK_A->>SDK_A: Confirm encryption; encrypt locally; prepare room-key sharing
    SDK_A->>Synapse: Send m.room.encrypted event and to-device key messages
    Synapse-->>SDK_B: Deliver encrypted events through /sync
    SDK_B->>SDK_B: Rust crypto decrypts after a room key is available
    SDK_B-->>ReactB: Decrypted Matrix event updates the room model
    ReactB-->>UserB: Render the message as text

    Note over FastAPI,Synapse: FastAPI never proxies message bodies. Synapse receives ciphertext for encrypted message events.
    Note over SDK_A,SDK_B: Private room membership and event timing remain visible metadata.
```

## Live verification

The test harnesses use synthetic accounts and rooms on a local development
Synapse. They do not reset user accounts, databases, crypto stores, keys, or
volumes. Test accounts and rooms remain after the run. Do not point the
harnesses at a shared or production homeserver.

Run frontend checks:

```sh
cd frontend
npm run typecheck
npm test
npm run build
```

With a local FastAPI API configured to allow synthetic registration, Vite,
and Synapse running:

```sh
cd frontend
LUMACHAT_TEST_API_URL=http://localhost:8000/api/v1 \
LUMACHAT_MATRIX_HOMESERVER_URL=http://localhost:8008 \
LUMACHAT_MATRIX_SERVER_NAME=localhost \
npm run test:e2ee-live
```

This Node SDK integration test exercises JWT-backed sessions, Rust crypto,
cross-signing, DM SAS verification, encrypted message exchange in both
directions, server-visible ciphertext, key backup and fresh-device recovery,
encrypted three-user group messaging, a late member's lack of earlier room
keys, and an unrelated account's inability to fetch the group event.

The React browser test additionally verifies that the browser's Rust crypto
client receives/decrypts a live event, that the React composer sends an event
User B decrypts, and that an event sent while the browser is offline is
decrypted after reconnect without refreshing:

```sh
cd frontend
CHROMIUM_EXECUTABLE=/opt/google/chrome/chrome \
LUMACHAT_TEST_API_URL=http://localhost:8000/api/v1 \
LUMACHAT_WEB_URL=http://localhost:5173 \
LUMACHAT_MATRIX_HOMESERVER_URL=http://localhost:8008 \
LUMACHAT_MATRIX_SERVER_NAME=localhost \
npm run test:e2ee-browser
```

Synapse rate-limits login attempts by client address. The live harness uses
multiple synthetic logins; on a local isolated development server, use a
temporary test-only login rate limit or allow the SDK test to wait for the
server's limit to refill. Restore local configuration after testing. Do not
weaken production rate limits for this test.

The `npm run test:matrix-live` script remains the Step 06 auth, plaintext-room
block, reconnect, logout, account-isolation, and mobile-layout regression.

## Further work

Future work may add QR verification, dehydrated-device support, a backend-owned
persistent Matrix device session, encrypted Matrix media, and broader recovery
UX. It must not share one crypto store between concurrent clients or silently
replace existing signing keys or backups.
