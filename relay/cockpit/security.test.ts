import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRequest, mintCsrfToken, loadOrMintCsrfToken } from "./security.js";

const TOKEN = "csrf-abc";
const base = {
  host: "127.0.0.1:4317",
  origin: undefined as string | undefined,
  csrfHeader: undefined as string | undefined,
  expectedCsrf: TOKEN,
  port: 4317,
};

describe("mintCsrfToken", () => {
  it("produces a long random hex token", () => {
    const a = mintCsrfToken();
    const b = mintCsrfToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe("loadOrMintCsrfToken — survives restart", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  it("mints once, then returns the SAME token on a later call (simulated restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "csrf-"));
    dirs.push(dir);
    const first = loadOrMintCsrfToken(dir);
    const second = loadOrMintCsrfToken(dir); // a fresh process would read the persisted file
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(second).toBe(first);
  });
});

describe("checkRequest — Host allowlist (DNS-rebind guard)", () => {
  it("allows 127.0.0.1 + localhost on the bound port", () => {
    expect(checkRequest({ ...base, method: "GET", host: "127.0.0.1:4317" }).ok).toBe(true);
    expect(checkRequest({ ...base, method: "GET", host: "localhost:4317" }).ok).toBe(true);
    expect(checkRequest({ ...base, method: "GET", host: "127.0.0.1" }).ok).toBe(true);
  });

  it("rejects a foreign Host (the rebinding attacker's domain)", () => {
    const v = checkRequest({ ...base, method: "GET", host: "evil.example.com" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(403);
  });

  it("rejects a mismatched port", () => {
    expect(checkRequest({ ...base, method: "GET", host: "127.0.0.1:9999" }).ok).toBe(false);
  });

  it("rejects a missing Host header", () => {
    expect(checkRequest({ ...base, method: "GET", host: undefined }).ok).toBe(false);
  });
});

describe("checkRequest — POST needs Origin + CSRF", () => {
  it("allows a POST with no Origin (same-origin fetch/curl) + valid CSRF", () => {
    expect(
      checkRequest({ ...base, method: "POST", origin: undefined, csrfHeader: TOKEN }).ok,
    ).toBe(true);
  });

  it("allows a POST from a localhost Origin + valid CSRF", () => {
    expect(
      checkRequest({
        ...base,
        method: "POST",
        origin: "http://127.0.0.1:4317",
        csrfHeader: TOKEN,
      }).ok,
    ).toBe(true);
  });

  it("rejects a POST from a cross-site Origin even with a guessed token", () => {
    const v = checkRequest({
      ...base,
      method: "POST",
      origin: "https://evil.example.com",
      csrfHeader: TOKEN,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/cross-origin/);
  });

  it("rejects a POST with a missing/bad CSRF token", () => {
    expect(
      checkRequest({ ...base, method: "POST", origin: undefined, csrfHeader: undefined }).ok,
    ).toBe(false);
    expect(
      checkRequest({ ...base, method: "POST", origin: undefined, csrfHeader: "wrong" }).ok,
    ).toBe(false);
  });

  it("does NOT require CSRF on GET", () => {
    expect(checkRequest({ ...base, method: "GET", csrfHeader: undefined }).ok).toBe(true);
  });
});
