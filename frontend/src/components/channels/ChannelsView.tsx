import { Hash } from "lucide-react";

/**
 * Organization channels need server-side organizations, memberships and room
 * authorization that the backend does not provide yet. Until then this view is
 * an honest empty state; it never lists placeholder channels or counts.
 */
export function ChannelsView() {
  return (
    <>
      <aside className="conversation-sidebar" aria-label="Channels">
        <header className="sidebar-header">
          <h1 className="sidebar-title">Channels</h1>
        </header>
        <div className="conversation-scroll">
          <p className="sidebar-empty">No organization channels are available to you.</p>
        </div>
      </aside>
      <section className="chat-main contact-detail" aria-label="Organization channels">
        <div className="empty-chat">
          <span className="empty-chat-icon"><Hash size={28} /></span>
          <h2>Organization channels aren’t available yet</h2>
          <p>
            Channels for teams and announcements need organization membership and permissions on the
            server. They will appear here once your organization has them set up.
          </p>
        </div>
      </section>
    </>
  );
}
