import { describe, expect, it } from "vitest";
import { sanitizeAlias } from "../src/auth/google-handler.js";
import { buildMimeMessage } from "../src/google/gmail.js";
import { decrypt, encrypt } from "../src/storage/crypto.js";

describe("sanitizeAlias", () => {
  it("normalizes aliases", () => {
    expect(sanitizeAlias(" Personal Mail ")).toBe("personal-mail");
    expect(sanitizeAlias("Work_1")).toBe("work_1");
  });

  it("rejects all", () => {
    expect(() => sanitizeAlias("all")).toThrow(/cannot be "all"/);
  });
});

describe("crypto", () => {
  it("round-trips", async () => {
    const secret = "test-secret-key-please-change";
    const plaintext = JSON.stringify({ refresh_token: "abc", email: "a@b.com" });
    const encrypted = await encrypt(plaintext, secret);
    expect(encrypted).not.toContain("abc");
    expect(await decrypt(encrypted, secret)).toBe(plaintext);
  });
});

describe("buildMimeMessage", () => {
  it("encodes a plain message", () => {
    const raw = buildMimeMessage({
      to: "user@example.com",
      subject: "Hello",
      body: "Hi there",
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).toContain("To: user@example.com");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded).toContain("Hi there");
  });

  it("rejects invalid recipients", () => {
    expect(() =>
      buildMimeMessage({ to: "not-an-email", subject: "x", body: "y" }),
    ).toThrow(/Invalid email/);
  });
});
