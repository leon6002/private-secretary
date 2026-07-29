// Cockpit security baseline (T8). The cockpit serves PRIVATE message
// content over HTTP on localhost, so it has to defend against the two
// things that can reach a loopback server from a browser: DNS-rebinding
// (a malicious page resolving its own hostname to 127.0.0.1) and CSRF
// (a cross-site POST riding the user's localhost session).
//
// Defenses, all enforced in checkRequest():
//   1. Host header allowlist — only localhost / 127.0.0.1 (+ the bound
//      port). Kills DNS-rebinding: the attacker's hostname never matches.
//   2. Origin header check on state-changing methods — must be absent
//      (same-origin fetch/curl) or one of the localhost origins.
//   3. CSRF token on POST — a random per-process token embedded in the
//      served HTML, required back in the x-csrf-token header.
//
// These are pure functions over header maps so they unit-test without a
// socket.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function mintCsrfToken(): string {
  return randomBytes(24).toString("hex");
}

// CSRF token persisted in the state dir so a cockpit RESTART keeps the same
// token — otherwise every restart mints a fresh per-process token and breaks
// already-open tabs ("missing or bad CSRF token"). Loopback-only single-user
// app, so a token on local disk is an acceptable defense-in-depth tradeoff.
// Reads <stateDir>/.csrf if present + non-empty; else mints + writes it.
export function loadOrMintCsrfToken(stateDir: string): string {
  const file = join(stateDir, ".csrf");
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim();
      if (t) return t;
    }
  } catch {
    // unreadable → fall through and mint a fresh one
  }
  const token = mintCsrfToken();
  try {
    writeFileSync(file, token);
  } catch {
    // can't persist (read-only dir) → still usable for this process
  }
  return token;
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  // Strip the port for comparison; accept with or without an explicit port.
  const hostname = host.split(":")[0]!.toLowerCase();
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (!allowedHosts.has(hostname)) return false;
  // If a port is present it must match the bound port.
  const parts = host.split(":");
  if (parts.length > 1) {
    const p = Number(parts[parts.length - 1]);
    if (Number.isFinite(p) && p !== port) return false;
  }
  return true;
}

function originAllowed(origin: string | undefined, port: number): boolean {
  // No Origin header (same-origin GET, curl, fetch same-origin) is fine.
  if (origin == null || origin === "" || origin === "null") return true;
  try {
    const u = new URL(origin);
    const okHost = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    const okPort = u.port === "" || Number(u.port) === port;
    return okHost && okPort;
  } catch {
    return false;
  }
}

export interface SecurityCheckInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  csrfHeader: string | undefined;
  expectedCsrf: string;
  port: number;
}

export type SecurityVerdict =
  | { ok: true }
  | { ok: false; status: number; reason: string };

export function checkRequest(input: SecurityCheckInput): SecurityVerdict {
  if (!hostAllowed(input.host, input.port)) {
    return { ok: false, status: 403, reason: "host not allowed (DNS-rebind guard)" };
  }
  const stateChanging = input.method !== "GET" && input.method !== "HEAD";
  if (stateChanging) {
    if (!originAllowed(input.origin, input.port)) {
      return { ok: false, status: 403, reason: "cross-origin request rejected" };
    }
    if (input.csrfHeader !== input.expectedCsrf) {
      return { ok: false, status: 403, reason: "missing or bad CSRF token" };
    }
  }
  return { ok: true };
}
