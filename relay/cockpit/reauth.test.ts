import { describe, it, expect } from "vitest";
import { failingGmailMailboxes } from "./reauth.js";

describe("failingGmailMailboxes", () => {
  it("returns [] when there is no gmail error", () => {
    expect(failingGmailMailboxes({})).toEqual([]);
    expect(failingGmailMailboxes(undefined)).toEqual([]);
    expect(failingGmailMailboxes({ "slack:direct": { message: "x", at: "t" } })).toEqual([]);
  });

  it("parses a single failing mailbox", () => {
    const errs = {
      "gmail:direct": { message: "mailbox=zhenghleo@gmail.com: OAuth refresh failed ... invalid_grant", at: "t" },
    };
    expect(failingGmailMailboxes(errs)).toEqual(["zhenghleo@gmail.com"]);
  });

  it("parses multiple failing mailboxes from one combined message", () => {
    const errs = {
      "gmail:direct": {
        message:
          "mailbox=huizhezheng@gmail.com: OAuth refresh failed for X: HTTP 400 invalid_grant; mailbox=zhenghleo@gmail.com: OAuth refresh failed for X: HTTP 400 invalid_grant",
        at: "t",
      },
    };
    expect(failingGmailMailboxes(errs)).toEqual(["huizhezheng@gmail.com", "zhenghleo@gmail.com"]);
  });

  it("de-dupes a mailbox that appears more than once", () => {
    const errs = {
      "gmail:direct": { message: "mailbox=a@x.com: err; mailbox=a@x.com: err again", at: "t" },
    };
    expect(failingGmailMailboxes(errs)).toEqual(["a@x.com"]);
  });
});
