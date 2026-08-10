import { describe, expect, it } from "vitest";
import { mentionedUserIds, renderSlackText } from "./slack-mrkdwn.js";

const names = new Map([["U08M6C96P2P", "Leo Zheng"]]);

describe("mentionedUserIds", () => {
  it("collects every mentioned id so they resolve in one pass", () => {
    expect(mentionedUserIds("Hi <@U1> and <@U2|old>, cc <@U1>")).toEqual(["U1", "U2", "U1"]);
  });

  it("finds none in plain text", () => {
    expect(mentionedUserIds("no mentions here")).toEqual([]);
  });
});

describe("renderSlackText", () => {
  // The complaint that prompted this: "看这个id根本不知道是谁".
  it("turns a mention into a name", () => {
    expect(renderSlackText("Hi <@U08M6C96P2P>, ok?", names)).toBe("Hi @Leo Zheng, ok?");
  });

  // An unknown id still reads as a mention rather than as raw wire syntax.
  it("keeps an unresolvable mention recognisable", () => {
    expect(renderSlackText("Hi <@U999>", names)).toBe("Hi @U999");
  });

  it("prefers Slack's own label when the id is unknown", () => {
    expect(renderSlackText("Hi <@U999|sandro>", names)).toBe("Hi @sandro");
  });

  // The screenshot showed the URL printed twice, once as target once as label.
  it("unwraps a labelled link to its label", () => {
    expect(renderSlackText("see <https://ex.com/a|ex.com/a>", names)).toBe("see ex.com/a");
  });

  it("unwraps a bare link to the url", () => {
    expect(renderSlackText("see <https://ex.com/a>", names)).toBe("see https://ex.com/a");
  });

  it("renders channels and broadcasts", () => {
    expect(renderSlackText("<#C1|general> <!here>", names)).toBe("#general @here");
  });

  // Links are unwrapped last; doing it first would eat the other <…> forms.
  it("handles a message mixing all of them", () => {
    expect(
      renderSlackText("<@U08M6C96P2P> see <https://ex.com|docs> in <#C1|eng>", names),
    ).toBe("@Leo Zheng see docs in #eng");
  });

  it("leaves ordinary text alone", () => {
    expect(renderSlackText("a < b and c > d", names)).toBe("a < b and c > d");
  });
});

describe("emoji shortcodes", () => {
  const names = new Map<string, string>();

  // The reported case: three in a row, rendered as raw codes in the cockpit.
  it("renders repeated shortcodes with no separator", () => {
    expect(
      renderSlackText(
        "Omg :rolling_on_the_floor_laughing::rolling_on_the_floor_laughing:",
        names,
      ),
    ).toBe("Omg 🤣🤣");
  });

  it("uses Slack's names, not GitHub's", () => {
    // gemoji calls these rofl / thinking / roll_eyes. Slack does not, and a
    // table built from the wrong project misses exactly these.
    expect(renderSlackText(":thinking_face: :face_with_rolling_eyes:", names)).toBe("🤔 🙄");
  });

  // A custom workspace emoji has no Unicode equivalent. Dropping it would
  // delete part of the message; leaving it costs two colons.
  it("leaves an unknown shortcode as written", () => {
    expect(renderSlackText("ship it :taiv-logo:", names)).toBe("ship it :taiv-logo:");
  });

  it("drops a trailing skin-tone modifier rather than rendering a swatch", () => {
    expect(renderSlackText(":+1::skin-tone-4:", names)).toBe("👍");
  });

  // ":b:" is a real emoji name (🅱️), so an unguarded pass rewrites links.
  it("does not touch colons inside a URL", () => {
    expect(renderSlackText("see https://ex.com/a:b:c now", names)).toBe(
      "see https://ex.com/a:b:c now",
    );
  });

  it("leaves a clock time alone", () => {
    expect(renderSlackText("at 10:30:00 sharp", names)).toBe("at 10:30:00 sharp");
  });
});
