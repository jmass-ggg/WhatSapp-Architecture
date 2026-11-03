import { BadgeCheck, Crown, FileText, Link2, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttachmentCard } from "../chat/AttachmentCard";
import { UserAvatar } from "../UserAvatar";
import { categoryMeta, memberLabel, roleLabel } from "./channelMeta";
import { channelsApi } from "../../services/api/channels";
import type { ApiClient } from "../../services/api/client";
import { extractSharedContent } from "../../services/matrix/sharedContent";
import type { Announcement, Channel, ChannelMember } from "../../types";

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

function formatDate(value?: Date | string | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "?";
}

interface PanelShellProps {
  id: "files" | "links" | "members" | "about";
  children: React.ReactNode;
}

function Panel({ id, children }: PanelShellProps) {
  return (
    <div className="channel-panel" id={`channel-panel-${id}`} role="tabpanel" aria-labelledby={`channel-tab-${id}`}>
      {children}
    </div>
  );
}

function PanelEmpty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty-chat channel-empty">
      <span className="empty-chat-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

export function FilesPanel({ announcements, joined, matrixToken }: { announcements: Announcement[]; joined: boolean; matrixToken?: string | null }) {
  const shared = useMemo(() => extractSharedContent(announcements), [announcements]);
  const items = [...shared.images, ...shared.files].sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
  return (
    <Panel id="files">
      {!joined ? (
        <PanelEmpty icon={<FileText size={28} />} title="Join to see files" text="Files shared in announcements are available to members." />
      ) : items.length === 0 ? (
        <PanelEmpty icon={<FileText size={28} />} title="No files yet" text="Images and files attached to loaded announcements appear here." />
      ) : (
        <ul className="channel-file-list">
          {items.map((item) => (
            <li key={item.eventId} className="channel-file-item">
              <AttachmentCard attachment={item.attachment} matrixToken={matrixToken} />
              <span className="channel-file-meta">{formatDate(item.sentAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function LinksPanel({ announcements, joined }: { announcements: Announcement[]; joined: boolean }) {
  const shared = useMemo(() => extractSharedContent(announcements), [announcements]);
  return (
    <Panel id="links">
      {!joined ? (
        <PanelEmpty icon={<Link2 size={28} />} title="Join to see links" text="Links shared in announcements are available to members." />
      ) : shared.links.length === 0 ? (
        <PanelEmpty icon={<Link2 size={28} />} title="No links yet" text="Links found in loaded announcements appear here." />
      ) : (
        <ul className="channel-link-list">
          {shared.links.map((link) => {
            let host = link.url;
            try {
              host = new URL(link.url).hostname;
            } catch {
              /* keep the raw URL */
            }
            return (
              <li key={`${link.eventId}-${link.url}`} className="channel-link-item">
                <Link2 size={16} aria-hidden="true" />
                <span className="channel-link-text">
                  <a href={link.url} target="_blank" rel="noopener noreferrer nofollow">{link.url}</a>
                  <small>{host}{link.sentAt ? ` · ${formatDate(link.sentAt)}` : ""}</small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

interface MembersPanelProps {
  api: ApiClient;
  channel: Channel;
  joined: boolean;
  currentUserId: string;
  matrixToken?: string | null;
  /** Changes whenever membership may have changed, to refetch. */
  refreshKey: unknown;
  onNotify: (message: string, kind: "success" | "error" | "info") => void;
  onMembershipChanged: () => void;
}

export function MembersPanel({ api, channel, joined, currentUserId, matrixToken, refreshKey, onNotify, onMembershipChanged }: MembersPanelProps) {
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const allowed = joined || channel.can_manage;

  useEffect(() => {
    if (!allowed) {
      setMembers(null);
      return;
    }
    let active = true;
    channelsApi
      .members(api, channel.id)
      .then((list) => {
        if (!active) return;
        setMembers(list);
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause, "Members could not be loaded."));
      });
    return () => {
      active = false;
    };
  }, [allowed, api, channel.id, refreshKey]);

  const changeRole = async (member: ChannelMember, role: "admin" | "member") => {
    setBusyId(member.user.id);
    try {
      const updated = await channelsApi.setRole(api, channel.id, member.user.id, role);
      setMembers((current) => current?.map((item) => (item.user.id === updated.user.id ? updated : item)) ?? current);
      onNotify(role === "admin" ? `@${member.user.username} is now a community admin.` : `@${member.user.username} is now a member.`, "success");
    } catch (cause) {
      onNotify(errorMessage(cause, "The role could not be changed."), "error");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member: ChannelMember) => {
    if (!window.confirm(`Remove @${member.user.username} from ${channel.name}?`)) return;
    setBusyId(member.user.id);
    try {
      await channelsApi.removeMember(api, channel.id, member.user.id);
      setMembers((current) => current?.filter((item) => item.user.id !== member.user.id) ?? current);
      onNotify(`@${member.user.username} was removed from the community.`, "success");
      onMembershipChanged();
    } catch (cause) {
      onNotify(errorMessage(cause, "The member could not be removed."), "error");
    } finally {
      setBusyId(null);
    }
  };

  if (!allowed) {
    return (
      <Panel id="members">
        <PanelEmpty icon={<UsersRound size={28} />} title="Join to see members" text={`${memberLabel(channel.member_count)} in this community.`} />
      </Panel>
    );
  }
  return (
    <Panel id="members">
      {error ? (
        <p className="sidebar-empty is-error" role="alert">{error}</p>
      ) : members === null ? (
        <p className="sidebar-empty" role="status">Loading members…</p>
      ) : (
        <ul className="channel-member-list" aria-label="Community members">
          {members.map((member) => {
            const name = member.user.profile?.display_name || member.user.username;
            const isSelf = member.user.id === currentUserId;
            const isOwner = member.role === "owner";
            // Owners (and application admins) assign roles and may remove admins; admins remove members only.
            const canChangeRole = channel.can_edit && !isSelf && !isOwner;
            const canRemove = !isSelf && !isOwner && (channel.can_edit || (channel.can_manage && member.role === "member"));
            return (
              <li key={member.user.id} className="channel-member">
                <UserAvatar name={name} initials={initialsFor(name)} size="sm" avatarUrl={member.user.profile?.profile_picture_url} matrixToken={matrixToken} />
                <span className="channel-member-text">
                  <strong>{name}{isSelf ? " (you)" : ""}</strong>
                  <small>@{member.user.username}{member.status === "invited" ? " · invited" : ""}</small>
                </span>
                <span className={`channel-role-badge${member.role !== "member" ? " is-admin" : ""}`}>
                  {isOwner ? <Crown size={13} aria-hidden="true" /> : member.role === "admin" ? <ShieldCheck size={13} aria-hidden="true" /> : null}
                  {roleLabel(member.role)}
                </span>
                {(canChangeRole || canRemove) && (
                  <span className="channel-member-actions">
                    {canChangeRole && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busyId === member.user.id}
                        onClick={() => void changeRole(member, member.role === "admin" ? "member" : "admin")}
                      >
                        {member.role === "admin" ? "Remove admin" : "Make admin"}
                      </button>
                    )}
                    {canRemove && (
                      <button type="button" className="link-button is-danger" disabled={busyId === member.user.id} onClick={() => void remove(member)}>
                        Remove
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

interface AboutPanelProps {
  channel: Channel;
  member: boolean;
  joined: boolean;
  busy: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onEdit: () => void;
}

export function AboutPanel({ channel, member, joined, busy, onJoin, onLeave, onEdit }: AboutPanelProps) {
  const category = categoryMeta(channel.category);
  const isOwner = member && channel.membership?.role === "owner";
  return (
    <Panel id="about">
      <div className="channel-about">
        <h2>
          {channel.name}
          {channel.is_verified && <BadgeCheck size={20} className="channel-verified" aria-label="Verified community" role="img" />}
        </h2>
        <p className="channel-about-description">{channel.description || "No description yet."}</p>
        <dl className="channel-about-facts">
          <dt>Category</dt>
          <dd>{category.label}</dd>
          <dt>Members</dt>
          <dd>{memberLabel(channel.member_count)}</dd>
          <dt>Created</dt>
          <dd>{formatDate(channel.created_at)}</dd>
          <dt>Your role</dt>
          <dd>{member && channel.membership ? roleLabel(channel.membership.role) : "Not a member"}</dd>
          <dt>Verified</dt>
          <dd>{channel.is_verified ? "Yes" : "No"}</dd>
        </dl>
        <div className="channel-about-actions">
          {!member && (
            <button type="button" className="primary-button" disabled={busy} onClick={onJoin}>{busy ? "Joining…" : "Join community"}</button>
          )}
          {joined && !isOwner && (
            <button type="button" className="secondary-button" disabled={busy} onClick={onLeave}>Leave community</button>
          )}
          {channel.can_edit && <button type="button" className="secondary-button" onClick={onEdit}>Edit community</button>}
        </div>
      </div>
    </Panel>
  );
}
