import { UserAvatar } from "../UserAvatar";
import { categoryMeta, channelInitials } from "./channelMeta";
import type { ChannelCategory } from "../../types";

interface ChannelAvatarProps {
  name: string;
  category: ChannelCategory;
  avatarUrl?: string | null;
  matrixToken?: string | null;
  size?: "sm" | "md" | "lg";
}

/** Lavender circle with the category icon, or the uploaded avatar when the channel has one. */
export function ChannelAvatar({ name, category, avatarUrl, matrixToken, size = "md" }: ChannelAvatarProps) {
  if (avatarUrl) {
    return (
      <UserAvatar
        name={name}
        initials={channelInitials(name)}
        accent={2}
        size={size}
        avatarUrl={avatarUrl}
        matrixToken={matrixToken}
        className="channel-avatar-image"
      />
    );
  }
  const { icon: Icon, label } = categoryMeta(category);
  const iconSize = size === "lg" ? 28 : size === "md" ? 22 : 18;
  return (
    <span className={`channel-avatar channel-avatar-${size}`} role="img" aria-label={`${name} (${label})`}>
      <Icon size={iconSize} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}
