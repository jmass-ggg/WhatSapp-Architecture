import { useEffect, useState } from "react";

import { fetchMatrixMedia } from "../services/matrix/media";
import type { PresenceState } from "../types";

interface UserAvatarProps {
  name: string;
  initials: string;
  accent?: number;
  size?: "sm" | "md" | "lg" | "xl";
  avatarUrl?: string | null;
  matrixToken?: string | null;
  /** Only "online" shows a dot; unknown/unavailable show nothing. */
  presence?: PresenceState;
  className?: string;
}

const accents = [
  "avatar-accent-mint",
  "avatar-accent-peach",
  "avatar-accent-lilac",
  "avatar-accent-blue",
  "avatar-accent-yellow",
  "avatar-accent-rose",
];

export function UserAvatar({
  name,
  initials,
  accent = 0,
  size = "md",
  avatarUrl,
  matrixToken,
  presence,
  className = "",
}: UserAvatarProps) {
  const [imageSource, setImageSource] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
    if (!avatarUrl) {
      setImageSource(null);
      return;
    }

    if (avatarUrl.startsWith("mxc://")) {
      if (!matrixToken) {
        setImageSource(null);
        return;
      }
      let active = true;
      let objectUrl: string | null = null;
      void fetchMatrixMedia(matrixToken, avatarUrl)
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setImageSource(objectUrl);
        })
        .catch(() => {
          if (active) setImageSource(null);
        });
      return () => {
        active = false;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }

    setImageSource(avatarUrl);
  }, [avatarUrl, matrixToken]);

  return (
    <span
      className={`user-avatar ${accents[Math.abs(accent) % accents.length]} avatar-${size} ${className}`.trim()}
      role="img"
      aria-label={name}
    >
      {imageSource && !imageFailed ? (
        <img
          src={imageSource}
          alt=""
          onError={() => setImageFailed(true)}
          draggable={false}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
      {presence === "online" && (
        <span className="avatar-presence is-online" role="img" aria-label="Online" />
      )}
      {presence === "offline" && <span className="sr-only">Offline</span>}
    </span>
  );
}
