import { act, render } from "@testing-library/react";
import { createRef, Profiler, type ProfilerOnRenderCallback } from "react";
import { describe, expect, it, vi } from "vitest";

import { MessageList, type MessageListHandle } from "../src/components/chat/MessageList";
import { conversationFromMatrixRoom } from "../src/services/matrix/rooms";
import type { Conversation } from "../src/types";
import { buildRoom, offlineClient, OWN_USER_ID, PEER_USER_ID, round, textEvent, writeReport } from "./support/harness";

// Every MessageBubble renders exactly one UserAvatar when ownAvatar is supplied,
// so counting avatar renders counts bubble renders without touching production code.
let avatarRenders = 0;
vi.mock("../src/components/UserAvatar", () => ({
  UserAvatar: () => {
    avatarRenders += 1;
    return <span data-avatar />;
  },
}));

const session = { access_token: "t", user_id: OWN_USER_ID, device_id: "d" };
const ownAvatar = { name: "Self" };

// Stable callbacks, as ChatPage provides via useCallback; inline lambdas here would defeat memo.
const listRef = createRef<MessageListHandle>();
const noop = () => undefined;

function Harness({ conversation, onRender }: { conversation: Conversation; onRender: ProfilerOnRenderCallback }) {
  return (
    <Profiler id="list" onRender={onRender}>
      <MessageList
        ref={listRef}
        conversation={conversation}
        matrixSession={session}
        searchTerm=""
        searchOpen={false}
        ownAvatar={ownAvatar}
        onReply={noop}
        onRetry={noop}
        onMentionClick={noop}
        onToggleStar={noop}
      />
    </Profiler>
  );
}

describe("MessageList render work per update (100 visible messages)", () => {
  it("measures bubble re-renders for typing-only, new-message and receipt updates", async () => {
    const client = offlineClient();
    const room = await buildRoom(client, "!render:localhost", 100);
    let commits: { phase: string; actual: number }[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
      commits.push({ phase, actual: actualDuration });
    };
    const measure = async (label: string, update: () => Promise<void> | void) => {
      avatarRenders = 0;
      commits = [];
      const start = performance.now();
      await act(async () => { await update(); });
      const wall = performance.now() - start;
      return {
        label,
        bubble_renders: avatarRenders,
        commits: commits.length,
        commit_ms: round(commits.reduce((a, c) => a + c.actual, 0)),
        wall_ms: round(wall),
      };
    };

    let conversation = conversationFromMatrixRoom(room, OWN_USER_ID);
    expect(conversation.messages.length).toBe(100);
    const view = render(<Harness conversation={conversation} onRender={onRender} />);
    const initial = { label: "initial render", bubble_renders: avatarRenders, commits: commits.length, commit_ms: round(commits.reduce((a, c) => a + c.actual, 0)) };
    // 100 bubbles mounted; anything above 100 is a second full render during mount.
    expect(initial.bubble_renders).toBeGreaterThanOrEqual(100);

    const rerender = (next: Conversation) => view.rerender(<Harness conversation={next} onRender={onRender} />);

    // 1. A typing notification: the session rebuilds the room; nothing in the timeline changed.
    const peer = room.getMember(PEER_USER_ID)!;
    peer.typing = true;
    const typing = await measure("typing-only refresh", () => {
      conversation = conversationFromMatrixRoom(room, OWN_USER_ID);
      rerender(conversation);
    });
    peer.typing = false;

    // 2. One incoming message appended.
    const newMessage = await measure("one new incoming message", async () => {
      await room.addLiveEvents([textEvent(room.roomId, PEER_USER_ID, 100)], { addToState: false });
      conversation = conversationFromMatrixRoom(room, OWN_USER_ID);
      rerender(conversation);
    });

    // 3. Burst of 20 incoming messages, one refresh each (as the live session does).
    const burstSamples: number[] = [];
    let burstRenders = 0;
    for (let i = 1; i <= 20; i++) {
      const result = await measure("burst", async () => {
        await room.addLiveEvents([textEvent(room.roomId, PEER_USER_ID, 100 + i)], { addToState: false });
        conversation = conversationFromMatrixRoom(room, OWN_USER_ID);
        rerender(conversation);
      });
      burstSamples.push(result.commit_ms);
      burstRenders += result.bubble_renders;
    }

    // 4. Unrelated prop churn: same conversation object re-rendered by the parent.
    const parentChurn = await measure("parent re-render, same conversation", () => rerender(conversation));

    const report = {
      visible_messages: 100,
      initial,
      typing_only: typing,
      one_new_message: newMessage,
      burst_20: { bubble_renders_total: burstRenders, commit_ms_total: round(burstSamples.reduce((a, b) => a + b, 0)) },
      parent_churn: parentChurn,
    };
    const file = writeReport("render", report);
    console.log(`\n[perf] render report -> ${file}\n${JSON.stringify(report, null, 2)}`);
  });
});
