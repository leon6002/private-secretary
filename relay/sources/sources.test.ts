import { describe, it, expect } from "vitest";
import { slackTsToMs, isoToMs } from "./types.js";
import { slackChannelsSource } from "./slack-channels.js";
import { getSource, SOURCES } from "./index.js";
import { hasAttachments } from "../core/types.js";

describe("time helpers", () => {
  it("slackTsToMs parses seconds.micro -> ms, 0 on garbage", () => {
    expect(slackTsToMs("1781140064.001200")).toBe(1781140064001);
    expect(slackTsToMs("nope")).toBe(0);
    expect(slackTsToMs(undefined)).toBe(0);
  });
  it("isoToMs parses ISO -> ms, 0 on garbage", () => {
    expect(isoToMs("2026-06-11T00:00:00Z")).toBe(Date.parse("2026-06-11T00:00:00Z"));
    expect(isoToMs("nope")).toBe(0);
  });
});

describe("slack-channels normalize", () => {
  const raw = {
    channel_id: "C02KACHMVUZ",
    messages: [
      { ts: "1781111378.000100", user: "U0ADA5V277C", text: "can someone look at box 3? <@UPHG4T8R1>" },
      { ts: "1781111400.000200", user: "U999", text: "no mention here", thread_ts: "1781111378.000100", reply_user_ids: ["UPHG4T8R1"] },
    ],
  };

  it("detects @mention of self and builds id/source/ts", () => {
    const m = slackChannelsSource.normalize(raw, { selfSlackId: "UPHG4T8R1" })[0]!;
    expect(m.id).toBe("slack:C02KACHMVUZ:1781111378.000100");
    expect(m.source).toBe("slack:C02KACHMVUZ");
    expect(m.platform).toBe("slack");
    expect(m.mentionsUser).toBe(true);
    expect(m.timestampMs).toBe(1781111378000);
  });

  it("flags reply-in-user-thread from participant list", () => {
    const msgs = slackChannelsSource.normalize(raw, { selfSlackId: "UPHG4T8R1" });
    expect(msgs[1]!.mentionsUser).toBe(false);
    expect(msgs[1]!.isReplyInUserThread).toBe(true);
  });

  it("no self id -> nothing is addressed", () => {
    const msgs = slackChannelsSource.normalize(raw, {});
    expect(msgs.every((m) => !m.mentionsUser && !m.isReplyInUserThread)).toBe(true);
  });

  it("tolerates a malformed batch", () => {
    expect(slackChannelsSource.normalize({}, {})).toEqual([]);
    expect(slackChannelsSource.normalize(null, {})).toEqual([]);
  });

  it("carries image/file attachments so the analyzer can't miss the screenshot", () => {
    // The Michael GST25A12 case: an empty-text message whose point is the screenshot.
    const withImg = {
      channel_id: "DR36HTSA3",
      messages: [
        { ts: "1781183576.154669", user: "UR36HT3HV", text: "", files: [{ id: "F0B9Q9VLDGB", name: "IMG_8146.png", mimetype: "image/png" }] },
      ],
    };
    const m = slackChannelsSource.normalize(withImg, { selfSlackId: "UPHG4T8R1" })[0]!;
    expect(hasAttachments(m)).toBe(true);
    expect(m.attachments).toEqual([{ id: "F0B9Q9VLDGB", kind: "image", name: "IMG_8146.png" }]);
  });

  it("A3: maps user_is_last_sender_in_channel through to userIsLastSenderInChannel, defaults false when omitted", () => {
    const r = {
      channel_id: "DR36HTSA3",
      messages: [
        { ts: "1.0", user: "U1", text: "with flag", user_is_last_sender_in_channel: true },
        { ts: "2.0", user: "U1", text: "without flag" },
      ],
    };
    const msgs = slackChannelsSource.normalize(r, { selfSlackId: "UPHG4T8R1" });
    expect(msgs[0]!.userIsLastSenderInChannel).toBe(true);
    expect(msgs[1]!.userIsLastSenderInChannel).toBe(false);
  });

  it("classifies non-image files as kind 'file' and omits attachments when none", () => {
    const r = {
      channel_id: "C1",
      messages: [
        { ts: "1.0", user: "U1", text: "doc", files: [{ id: "F1", name: "spec.pdf", mimetype: "application/pdf" }] },
        { ts: "2.0", user: "U1", text: "no files" },
      ],
    };
    const msgs = slackChannelsSource.normalize(r, {});
    expect(msgs[0]!.attachments).toEqual([{ id: "F1", kind: "file", name: "spec.pdf" }]);
    expect(hasAttachments(msgs[1]!)).toBe(false);
    expect(msgs[1]!.attachments).toBeUndefined();
  });
});

describe("registry — only person-to-person messaging channels are sources", () => {
  it("resolves slack-channels and rejects non-sources (jira/notion are not sources)", () => {
    expect(getSource("slack-channels")).toBe(slackChannelsSource);
    expect(getSource("jira")).toBeUndefined();
    expect(getSource("notion")).toBeUndefined();
    expect(Object.keys(SOURCES)).toEqual(["slack-channels"]);
  });
});
