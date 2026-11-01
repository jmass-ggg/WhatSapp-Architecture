import { expect, it } from "vitest";

import { roleForPowerLevel, roomMembers, roomTopic } from "./members";

const member = (userId: string, name: string, powerLevel: number) => ({ userId, name, powerLevel, getMxcAvatarUrl: () => null });

it("maps power levels to roles and sorts admins first", () => {
  expect([0, 50, 100].map(roleForPowerLevel)).toEqual(["member", "moderator", "admin"]);
  const list = roomMembers({
    getJoinedMembers: () => [member("@z", "Zed", 0), member("@a", "Amy", 0), member("@o", "Owner", 100)],
  } as never);
  expect(list.map((m) => [m.name, m.role])).toEqual([["Owner", "admin"], ["Amy", "member"], ["Zed", "member"]]);
});

it("reads the room topic only when one is set", () => {
  const withTopic = { currentState: { getStateEvents: () => ({ getContent: () => ({ topic: " Plans " }) }) } };
  expect(roomTopic(withTopic as never)).toBe("Plans");
  expect(roomTopic({ currentState: { getStateEvents: () => null } } as never)).toBeUndefined();
});
