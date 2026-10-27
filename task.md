08

Enable end-to-end encryption

Initialize Rust crypto in the client and create encrypted rooms from the beginning. Configure device keys, verification and secure key backup/recovery.
Completion condition: Messages encrypt before upload and decrypt on another user's device.




09

Develop one-to-one messaging

Implement contact selection, private encrypted rooms, message bubbles, sending/receiving, timestamps, unread counts and live conversation updates.
Completion condition: Alice and Bob exchange encrypted messages in two browsers.




10

Keep the active interface focused on one-to-one chats

Keep existing Matrix group rooms and their history intact, but do not expose group creation or group rooms in the active application.
Completion condition: the active conversation list contains only private one-to-one rooms.




11

Implement typing and message status

Show who is typing, sent acknowledgment, read receipts, seen indicators and read timestamps. For a true 'delivered to device' indicator, add a separate recipient-client acknowledgment.
Completion condition: Message indicators update correctly between users.
