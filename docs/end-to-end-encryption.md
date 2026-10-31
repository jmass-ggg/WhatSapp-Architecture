# Matrix End-to-End Encryption (retired)

End-to-end encryption was removed from the LumaChat frontend. The application
now creates and uses **plaintext** Matrix rooms only. Synapse can read message
bodies, file names and media URIs in these rooms.

* No Rust crypto, device verification, recovery keys, key backup or
  cross-signing code remains in the client.
* Rooms that still carry an `m.room.encryption` state event cannot be converted;
  they are hidden from the UI, never reused, and never sent to.
* See `CHAT_SIMPLIFICATION_RESULT.md` for the retirement and cleanup procedure
  and `scripts/admin/retire-encrypted-rooms.py` for the Synapse admin tooling.
