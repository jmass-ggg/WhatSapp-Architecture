import type { ApiClient } from "./client";
import type {
  Channel,
  ChannelCreateInput,
  ChannelMember,
  ChannelMemberRole,
  ChannelUpdateInput,
} from "../../types";

const path = (channelId: string, suffix = "") => `/channels/${encodeURIComponent(channelId)}${suffix}`;

export const channelsApi = {
  list: (api: ApiClient) => api.request<Channel[]>("/channels"),
  get: (api: ApiClient, channelId: string) => api.request<Channel>(path(channelId)),
  create: (api: ApiClient, input: ChannelCreateInput) =>
    api.request<Channel>("/channels", { method: "POST", body: JSON.stringify(input) }),
  update: (api: ApiClient, channelId: string, input: ChannelUpdateInput) =>
    api.request<Channel>(path(channelId), { method: "PATCH", body: JSON.stringify(input) }),
  archive: (api: ApiClient, channelId: string) =>
    api.request<void>(path(channelId), { method: "DELETE" }),
  join: (api: ApiClient, channelId: string) =>
    api.request<Channel>(path(channelId, "/join"), { method: "POST" }),
  leave: (api: ApiClient, channelId: string) =>
    api.request<Channel>(path(channelId, "/leave"), { method: "POST" }),
  members: (api: ApiClient, channelId: string) =>
    api.request<ChannelMember[]>(path(channelId, "/members")),
  setRole: (api: ApiClient, channelId: string, userId: string, role: ChannelMemberRole) =>
    api.request<ChannelMember>(path(channelId, `/members/${encodeURIComponent(userId)}/role`), {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeMember: (api: ApiClient, channelId: string, userId: string) =>
    api.request<void>(path(channelId, `/members/${encodeURIComponent(userId)}`), { method: "DELETE" }),
};
