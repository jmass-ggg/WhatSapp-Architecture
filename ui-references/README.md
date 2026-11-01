# Recruitable Chat — Target UI References

These three images are visual DESIGN REFERENCES, not existing implemented functionality or app data.

1. `01-chats-contact-info.png` — Chats active; right contact info panel open, with profile, media, files, links and starred items.
2. `02-organization-channels.png` — Channels active; department channels for Engineering/Finance/HR etc, announcement layout and tabs. IMPORTANT: the image mistakenly highlights Chats and Channels at the same time. Implement ONLY Channels as active. Do not fabricate subscriber counts or content.
3. `03-chats-full-width.png` — Chats active; no right panel, main message area expands.

Implement these in the existing React/Vite frontend using real Matrix/backend data. Navy slim left navigation should be approx 72-80px; only one primary nav state active. Do not add voice/video buttons. Channels require tenant and permission-aware backend work, not just static cards.
