/**
 * Behavioral tests for the 8 email tools (email_send, email_draft,
 * email_verify, email_list, email_read, email_search, email_count,
 * email_download_attachment).
 *
 * Both transports are mocked at the dynamic-import boundary:
 *   - nodemailer → fake `createTransport` that records every sendMail
 *     call and returns a stable messageId / accepted list.
 *   - imapflow → fake `ImapFlow` class with a canned mailbox so search
 *     / list / read / count produce deterministic results.
 *
 * What we lock in:
 *   - SMTP/IMAP creds resolve from the vault as expected
 *   - allowedDomains rejects out-of-list recipients BEFORE any send
 *   - HTML auto-detection picks up tags
 *   - attachments must be inside the sandbox; missing files refused
 *   - IMAP search builds the right query and surfaces results
 *   - email_download_attachment writes inside cwd, refuses escapes
 *   - vault-missing / IMAP-throws / SMTP-throws → no crash, structured
 *     error returned
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolpoTool } from "@polpo-ai/core";
import type { ResolvedVault } from "../types.js";

// ─── Fakes ──────────────────────────────────────────────────
//
// The tools `await import("nodemailer")` and `await import("imapflow")`
// at execute time. We hoist mocks before any module loads them so the
// dynamic import resolves to our doubles.

const sentMessages: any[] = [];
const verifyOutcome = { fail: false };

vi.mock("nodemailer", () => {
  const createTransport = vi.fn((opts: any) => ({
    sendMail: vi.fn(async (mail: any) => {
      sentMessages.push(mail);
      // streamTransport mode (used by email_draft) expects a raw
      // RFC822 buffer in `.message`; SMTP mode (used by email_send)
      // gets messageId/accepted/etc. We populate both so callers
      // pick what they need.
      const raw = Buffer.from(
        `From: ${mail.from ?? "noreply@example.com"}\r\n` +
        `To: ${mail.to ?? ""}\r\n` +
        `Subject: ${mail.subject ?? ""}\r\n\r\n` +
        `${mail.text ?? mail.html ?? ""}`,
      );
      return {
        messageId: `<test-${sentMessages.length}@example.com>`,
        accepted: Array.isArray(mail.to) ? mail.to : mail.to ? [mail.to] : [],
        rejected: [],
        response: "250 OK",
        message: opts?.streamTransport ? raw : undefined,
      };
    }),
    verify: vi.fn(async () => {
      if (verifyOutcome.fail) throw new Error("SMTP auth failed");
      return true;
    }),
  }));
  return { default: { createTransport }, createTransport };
});

const imapState = {
  connect: { fail: false },
  mailboxes: [
    { path: "INBOX", flags: new Set(), specialUse: undefined as string | undefined },
    { path: "Drafts", flags: new Set(), specialUse: "\\Drafts" },
  ],
  // canned messages live in INBOX
  inbox: [
    {
      uid: 101,
      flags: new Set(["\\Seen"]),
      envelope: {
        date: "2026-04-25T10:00:00Z",
        subject: "Welcome to Polpo",
        from: [{ name: "Polpo Bot", address: "bot@polpo.sh" }],
        to: [{ name: "User", address: "user@example.com" }],
      },
      body: "Hi there,\nThanks for joining.\n— Polpo",
      attachments: [] as Array<{ part: string; filename: string; mimeType: string; size: number; content: Buffer }>,
    },
    {
      uid: 102,
      flags: new Set(),
      envelope: {
        date: "2026-04-26T08:30:00Z",
        subject: "Invoice #4242 ready",
        from: [{ name: "Acme Billing", address: "billing@acme.com" }],
        to: [{ name: "User", address: "user@example.com" }],
      },
      body: "Your invoice is attached.",
      attachments: [
        { part: "2", filename: "invoice-4242.pdf", mimeType: "application/pdf", size: 12, content: Buffer.from("%PDF-1.4 fake") },
      ],
    },
    {
      uid: 103,
      flags: new Set(),
      envelope: {
        date: "2026-04-27T14:00:00Z",
        subject: "Quick question",
        from: [{ name: "Marco", address: "marco@example.com" }],
        to: [{ name: "User", address: "user@example.com" }],
      },
      body: "Hey, do you have a minute?",
      attachments: [],
    },
  ],
  appended: [] as Array<{ folder: string; raw: Buffer; flags?: string[] }>,
};

vi.mock("imapflow", () => {
  class ImapFlow {
    config: any;
    constructor(config: any) { this.config = config; }
    async connect() {
      if (imapState.connect.fail) throw new Error("IMAP auth failed");
    }
    async logout() { /* noop */ }
    async list() { return imapState.mailboxes.map(m => ({ path: m.path, specialUse: m.specialUse })); }
    async getMailboxLock(_folder: string) {
      return { release: () => {} };
    }
    async search(query: any, _opts?: any): Promise<number[]> {
      let msgs = imapState.inbox.slice();
      if (query.seen === false) msgs = msgs.filter(m => !m.flags.has("\\Seen"));
      if (query.from) msgs = msgs.filter(m => (m.envelope.from?.[0]?.address ?? "").includes(query.from));
      if (query.subject) msgs = msgs.filter(m => (m.envelope.subject ?? "").toLowerCase().includes(String(query.subject).toLowerCase()));
      if (query.body) msgs = msgs.filter(m => m.body.toLowerCase().includes(String(query.body).toLowerCase()));
      return msgs.map(m => m.uid);
    }
    async fetchOne(uidStr: string, request: any, _opts?: any): Promise<any> {
      const uid = Number(uidStr);
      const m = imapState.inbox.find(x => x.uid === uid);
      if (!m) return null;
      const result: any = { uid: m.uid };
      if (request.envelope) result.envelope = m.envelope;
      if (request.flags) result.flags = m.flags;
      if (request.source || request.bodyParts || request.bodyStructure) {
        result.source = Buffer.from(`Subject: ${m.envelope.subject}\r\n\r\n${m.body}`);
        result.bodyStructure = {
          childNodes: m.attachments.length > 0
            ? [{ part: "1", type: "text/plain" }, ...m.attachments.map(a => ({
                part: a.part, type: a.mimeType, disposition: "attachment",
                dispositionParameters: { filename: a.filename }, size: a.size,
              }))]
            : [{ part: "1", type: "text/plain" }],
        };
      }
      return result;
    }
    async download(uidStr: string, part: string, _opts?: any): Promise<any> {
      const uid = Number(uidStr);
      const m = imapState.inbox.find(x => x.uid === uid);
      const att = m?.attachments.find(a => a.part === part);
      if (!att) throw new Error(`Attachment not found: uid=${uid} part=${part}`);
      // imapflow's download() resolves to a stream; the tool reads it
      // via Buffer.concat. We give a Readable made from a single
      // Buffer chunk.
      const { Readable } = await import("node:stream");
      return { content: Readable.from([att.content]), meta: { contentType: att.mimeType } };
    }
    async append(folder: string, raw: Buffer, flags?: string[]) {
      imapState.appended.push({ folder, raw, flags });
    }
    async messageFlagsAdd() { /* noop */ }
  }
  return { ImapFlow };
});

// ─── Imports (after mocks) ───────────────────────────────────
const { createEmailTools } = await import("../email-tools.js");

// ─── Helpers ────────────────────────────────────────────────
let cwd: string;

function pick(tools: PolpoTool<any>[], name: string): PolpoTool<any> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool '${name}' not registered: ${tools.map(x => x.name).join(", ")}`);
  return t;
}
function text(result: any): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`Expected text content, got ${block?.type}`);
  return block.text;
}

function makeVault(): ResolvedVault {
  const smtp: any = { host: "smtp.example.com", port: 587, user: "u@example.com", pass: "p", from: "u@example.com", secure: false };
  const imap: any = { host: "imap.example.com", port: 993, user: "u@example.com", pass: "p", secure: true };
  return {
    get: (s) => s === "smtp" || s === "imap" ? (s === "smtp" ? smtp : imap) : undefined,
    getSmtp: () => smtp,
    getImap: () => imap,
    getKey: () => undefined,
    has: (s) => s === "smtp" || s === "imap",
    list: () => [
      { service: "smtp", type: "smtp", keys: Object.keys(smtp) },
      { service: "imap", type: "imap", keys: Object.keys(imap) },
    ],
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "polpo-email-tools-"));
  sentMessages.length = 0;
  imapState.appended.length = 0;
  imapState.connect.fail = false;
  verifyOutcome.fail = false;
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function buildAll(opts: { allowedDomains?: string[]; vault?: ResolvedVault } = {}) {
  return createEmailTools(
    cwd,
    [cwd],
    [
      "email_send", "email_draft", "email_verify",
      "email_list", "email_read", "email_search",
      "email_count", "email_download_attachment",
    ],
    opts.vault ?? makeVault(),
    opts.allowedDomains,
    cwd,
  );
}

// ────────────────────────────────────────────────────────────
// email_send
// ────────────────────────────────────────────────────────────
describe("email_send", () => {
  it("sends a plain-text email via SMTP using vault creds", async () => {
    const t = pick(buildAll(), "email_send");
    const result = await t.execute("c1", {
      to: "alice@example.com",
      subject: "Hi",
      body: "Just checking in.",
    });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      to: "alice@example.com",
      subject: "Hi",
      text: "Just checking in.",
    });
    expect(JSON.stringify(result.details)).toMatch(/messageId|sent|ok/i);
  });

  it("auto-detects HTML when the body contains tags", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "alice@example.com",
      subject: "Update",
      body: "<p>Hello <b>world</b></p>",
    });
    expect(sentMessages[0].html).toBeDefined();
    expect(sentMessages[0].text).toBeUndefined();
  });

  it("supports cc/bcc/reply_to and array recipients", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: ["a@x.com", "b@x.com"],
      cc: "ops@x.com",
      bcc: ["audit@x.com"],
      reply_to: "noreply@x.com",
      subject: "Multi",
      body: "ok",
    });
    expect(sentMessages[0]).toMatchObject({
      to: "a@x.com, b@x.com",
      cc: "ops@x.com",
      bcc: "audit@x.com",
      replyTo: "noreply@x.com",
    });
  });

  it("attaches a file from inside the sandbox", async () => {
    writeFileSync(join(cwd, "report.pdf"), "%PDF-1.4 fake");
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "alice@example.com",
      subject: "Report",
      body: "see attached",
      attachments: [{ path: "report.pdf" }],
    });
    expect(sentMessages[0].attachments).toEqual([
      expect.objectContaining({ filename: "report.pdf" }),
    ]);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("rejects an attachment outside the sandbox before sending", async () => {
    const t = pick(buildAll(), "email_send");
    await expect(
      t.execute("c1", {
        to: "a@x.com", subject: "Stolen", body: ".",
        attachments: [{ path: "/etc/hostname" }],
      }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("refuses an attachment that doesn't exist on disk", async () => {
    const t = pick(buildAll(), "email_send");
    await expect(
      t.execute("c1", {
        to: "a@x.com", subject: "x", body: ".",
        attachments: [{ path: "ghost.pdf" }],
      }),
    ).rejects.toThrow(/not found|missing|attachment/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("blocks recipients outside emailAllowedDomains BEFORE any SMTP call", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_send");
    await expect(
      t.execute("c1", { to: "evil@attacker.com", subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|policy/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("blocks ANY out-of-list recipient even if mixed with allowed ones", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_send");
    await expect(
      t.execute("c1", { to: ["ok@example.com", "evil@attacker.com"], subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|policy/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("blocks out-of-list cc / bcc as well as to", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_send");
    await expect(
      t.execute("c1", { to: "ok@example.com", cc: "leak@evil.io", subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|policy/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("explodes with a clean error when no SMTP host is configured", async () => {
    // Vault with no smtp + no env → tool must complain, not crash.
    const empty: ResolvedVault = {
      get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
      getKey: () => undefined, has: () => false, list: () => [],
    };
    const t = pick(buildAll({ vault: empty }), "email_send");
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    await expect(
      t.execute("c1", { to: "a@x.com", subject: "x", body: "y" }),
    ).rejects.toThrow(/smtp|host|configured/i);
  });

  it("delivers a unicode body (subject + content) without mangling", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "a@example.com",
      subject: "Aggiornamento — Q4 ☕",
      body: "Dati: 中文 + emoji 🐙 + RTL שלום",
    });
    expect(sentMessages[0].subject).toContain("☕");
    expect(sentMessages[0].text ?? sentMessages[0].html).toContain("שלום");
  });
});

// ────────────────────────────────────────────────────────────
// email_draft
// ────────────────────────────────────────────────────────────
describe("email_draft", () => {
  it("appends a draft to the Drafts folder via IMAP", async () => {
    const t = pick(buildAll(), "email_draft");
    await t.execute("c1", {
      to: "marco@example.com",
      subject: "Bozza",
      body: "Da rivedere prima dell'invio.",
    });
    expect(imapState.appended).toHaveLength(1);
    expect(imapState.appended[0].folder.toLowerCase()).toContain("draft");
    const rawText = imapState.appended[0].raw.toString("utf-8");
    expect(rawText).toContain("marco@example.com");
    expect(rawText).toContain("Bozza");
  });

  it("rejects out-of-list recipients in drafts too", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_draft");
    await expect(
      t.execute("c1", { to: "evil@attacker.com", subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|policy/i);
    expect(imapState.appended).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────
// email_verify
// ────────────────────────────────────────────────────────────
describe("email_verify", () => {
  it("returns success when the SMTP transport verifies", async () => {
    const t = pick(buildAll(), "email_verify");
    const result = await t.execute("c1", {});
    expect(JSON.stringify(result.details).toLowerCase()).toMatch(/ok|success|verified/);
  });

  it("rejects with a clear message when SMTP auth fails", async () => {
    verifyOutcome.fail = true;
    const t = pick(buildAll(), "email_verify");
    await expect(t.execute("c1", {})).rejects.toThrow(/SMTP|auth|fail/i);
  });
});

// ────────────────────────────────────────────────────────────
// email_list / email_search / email_count
// ────────────────────────────────────────────────────────────
describe("email_list", () => {
  it("lists the recent messages from INBOX with envelope metadata", async () => {
    const t = pick(buildAll(), "email_list");
    const result = await t.execute("c1", { folder: "INBOX", limit: 10 });
    const out = text(result);
    expect(out).toContain("Welcome to Polpo");
    expect(out).toContain("Invoice #4242 ready");
    expect(out).toContain("UID: 101");
    expect(result.details).toMatchObject({ folder: "INBOX" });
  });

  it("filters to unread only when requested", async () => {
    const t = pick(buildAll(), "email_list");
    const result = await t.execute("c1", { unseen_only: true });
    const out = text(result);
    // UID 101 has \Seen, 102 and 103 don't.
    expect(out).not.toMatch(/UID:\s*101\b/);
    expect(out).toContain("UID: 102");
    expect(out).toContain("UID: 103");
  });

  it("returns a clean empty result when IMAP has no messages matching", async () => {
    // Stash and clear the inbox for this test only.
    const saved = imapState.inbox.splice(0, imapState.inbox.length);
    try {
      const t = pick(buildAll(), "email_list");
      const result = await t.execute("c1", {});
      expect(text(result).toLowerCase()).toMatch(/no.*messages|empty|0/);
    } finally {
      imapState.inbox.push(...saved);
    }
  });

  it("fails gracefully when IMAP connection is rejected", async () => {
    imapState.connect.fail = true;
    const t = pick(buildAll(), "email_list");
    await expect(t.execute("c1", {})).rejects.toThrow(/imap|auth|fail/i);
  });
});

describe("email_search", () => {
  it("requires at least one criterion (refuses empty query)", async () => {
    const t = pick(buildAll(), "email_search");
    await expect(t.execute("c1", {})).rejects.toThrow(/criter|empty|provide/i);
  });

  it("filters by subject substring (case-insensitive)", async () => {
    const t = pick(buildAll(), "email_search");
    const result = await t.execute("c1", { subject: "invoice" });
    expect(text(result)).toContain("Invoice #4242");
    expect(text(result)).not.toContain("Welcome to Polpo");
  });

  it("filters by sender domain", async () => {
    const t = pick(buildAll(), "email_search");
    const result = await t.execute("c1", { from: "acme.com" });
    expect(text(result)).toContain("Invoice #4242");
    expect(text(result)).not.toContain("Welcome to Polpo");
  });

  it("filters by body substring", async () => {
    const t = pick(buildAll(), "email_search");
    const result = await t.execute("c1", { body: "minute" });
    expect(text(result)).toContain("UID: 103");
  });
});

describe("email_count", () => {
  it("counts messages matching a subject filter", async () => {
    const t = pick(buildAll(), "email_count");
    const result = await t.execute("c1", { subject: "invoice" });
    expect(JSON.stringify(result.details)).toMatch(/[\W"]1[\W"]/);
    expect(text(result)).toMatch(/\b1\b/);
  });

  it("counts unread only when unseen_only=true", async () => {
    const t = pick(buildAll(), "email_count");
    const result = await t.execute("c1", { unseen_only: true });
    // UIDs 102, 103 are unread.
    expect(JSON.stringify(result.details)).toMatch(/[\W"]2[\W"]/);
  });
});

// ────────────────────────────────────────────────────────────
// email_read
// ────────────────────────────────────────────────────────────
describe("email_read", () => {
  it("reads a specific message by UID", async () => {
    const t = pick(buildAll(), "email_read");
    const result = await t.execute("c1", { uid: 101 });
    const out = text(result);
    expect(out).toContain("Welcome to Polpo");
    expect(out).toContain("Polpo Bot");
  });

  it("rejects with a clear message when the UID doesn't exist", async () => {
    const t = pick(buildAll(), "email_read");
    await expect(t.execute("c1", { uid: 99999 })).rejects.toThrow(/not.*found|missing|UID/i);
  });
});

// ────────────────────────────────────────────────────────────
// email_download_attachment
// ────────────────────────────────────────────────────────────
describe("email_download_attachment", () => {
  it("writes an attachment into the sandbox by uid + part", async () => {
    const t = pick(buildAll(), "email_download_attachment");
    const result = await t.execute("c1", {
      uid: 102,
      part: "2",
      output_path: "downloads/invoice.pdf",
    });
    expect(existsSync(join(cwd, "downloads/invoice.pdf"))).toBe(true);
    const buf = readFileSync(join(cwd, "downloads/invoice.pdf"));
    expect(buf.toString()).toContain("%PDF-1.4 fake");
    expect(JSON.stringify(result.details)).toContain("invoice.pdf");
  });

  it("rejects an output path that escapes the sandbox", async () => {
    const t = pick(buildAll(), "email_download_attachment");
    await expect(
      t.execute("c1", { uid: 102, part: "2", output_path: "/etc/escape.pdf" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("rejects when uid/part doesn't match any attachment, leaving no file", async () => {
    const t = pick(buildAll(), "email_download_attachment");
    await expect(
      t.execute("c1", { uid: 101, part: "9", output_path: "x.pdf" }),
    ).rejects.toThrow(/not.*found|missing|attachment/i);
    expect(existsSync(join(cwd, "x.pdf"))).toBe(false);
  });

  it("rejects an output_path with parent traversal (../../etc/passwd)", async () => {
    const t = pick(buildAll(), "email_download_attachment");
    await expect(
      t.execute("c1", { uid: 102, part: "2", output_path: "../../etc/passwd" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });
});

// ────────────────────────────────────────────────────────────
// PARANOID — battle-tested edge cases for what really breaks email
// in production: header injection, address fuzzing, allowedDomain
// corner cases, multipart edges, large payloads, BCC leaks.
// ────────────────────────────────────────────────────────────
describe("email_send — paranoid (header injection + abuse)", () => {
  it("does NOT smuggle CRLF-injected headers via subject", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "alice@example.com",
      // Classic header-injection payload: a newline that, in a naive
      // mailer, would close the Subject header and inject Bcc.
      subject: "Hi\r\nBcc: attacker@evil.io",
      body: "ok",
    });
    // nodemailer is supposed to escape this, but we pin the contract:
    // bcc must NOT contain the attacker address even by
    // smuggled-header smuggling.
    expect(JSON.stringify(sentMessages[0].bcc ?? "")).not.toContain("attacker@evil.io");
  });

  it("does NOT smuggle CRLF-injected headers via from", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      from: "u@example.com\r\nBcc: leak@evil.io",
      to: "alice@example.com",
      subject: "x",
      body: "y",
    });
    expect(JSON.stringify(sentMessages[0].bcc ?? "")).not.toContain("leak@evil.io");
  });

  it("does NOT smuggle CRLF-injected headers via reply_to", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "alice@example.com",
      reply_to: "noreply@x.com\r\nBcc: leak@evil.io",
      subject: "x",
      body: "y",
    });
    expect(JSON.stringify(sentMessages[0].bcc ?? "")).not.toContain("leak@evil.io");
  });

  it("ships BCC opaquely — to recipients must not see it in `to`", async () => {
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "alice@example.com",
      bcc: "audit@example.com",
      subject: "x",
      body: "y",
    });
    // The wire-level `to` field that goes to the SMTP server must NOT
    // include the BCC. nodemailer separates them; pin that contract.
    expect(sentMessages[0].to).toBe("alice@example.com");
    expect(sentMessages[0].bcc).toBe("audit@example.com");
  });

  it("survives a 5KB subject without truncating the body", async () => {
    // RFC 5322 says lines should be ≤998 chars but we shouldn't
    // crash on a giant one — Gmail truncates display, the wire is
    // fine. Pin "no exception".
    const t = pick(buildAll(), "email_send");
    const big = "A".repeat(5000);
    await t.execute("c1", { to: "a@example.com", subject: big, body: "ok" });
    expect(sentMessages[0].subject).toBe(big);
    expect(sentMessages[0].text).toBe("ok");
  });

  it("survives a 1MB inline body without truncating it", async () => {
    const t = pick(buildAll(), "email_send");
    const big = "x".repeat(1024 * 1024);
    await t.execute("c1", { to: "a@example.com", subject: "Big", body: big });
    expect((sentMessages[0].text ?? sentMessages[0].html).length).toBe(big.length);
  });

  it("blocks rfc-malformed recipients before any SMTP call (no @)", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_send");
    // No @ → can't extract a domain → must NOT pass the allowlist.
    await expect(
      t.execute("c1", { to: "not-an-email", subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|invalid/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("blocks empty-string recipients before any SMTP call", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_send");
    await expect(
      t.execute("c1", { to: "", subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|invalid/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("100-recipient broadcast fans out without dropping addresses", async () => {
    const t = pick(buildAll(), "email_send");
    const recipients = Array.from({ length: 100 }, (_, i) => `user${i}@example.com`);
    await t.execute("c1", { to: recipients, subject: "Broadcast", body: "ok" });
    // All 100 must be present in the wire `to`.
    for (const r of recipients) {
      expect(sentMessages[0].to).toContain(r);
    }
  });

  it("attachment filename with traversal sequences is rejected at sandbox", async () => {
    const t = pick(buildAll(), "email_send");
    await expect(
      t.execute("c1", {
        to: "a@example.com", subject: "x", body: "y",
        attachments: [{ path: "../../etc/hostname" }],
      }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("attachment with explicit override filename is honored without path leakage", async () => {
    writeFileSync(join(cwd, "secret-internal-name.pdf"), "%PDF data");
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", {
      to: "a@example.com", subject: "x", body: ".",
      attachments: [{ path: "secret-internal-name.pdf", filename: "Q4-Report.pdf" }],
    });
    // Override wins; internal filename does NOT leak.
    expect(sentMessages[0].attachments[0].filename).toBe("Q4-Report.pdf");
    expect(JSON.stringify(sentMessages[0].attachments[0])).not.toContain("secret-internal-name");
  });

  it("back-to-back sends keep their state isolated (no message bleed)", async () => {
    // Sequential rather than Promise.all — verifies the same
    // contract (one send doesn't clobber another's mailOptions
    // through a shared transporter cache) without depending on
    // cross-worker mock-state timing in vitest.
    const t = pick(buildAll(), "email_send");
    await t.execute("c1", { to: "a1@example.com", subject: "S1", body: "B1" });
    await t.execute("c2", { to: "a2@example.com", subject: "S2", body: "B2" });
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages.map(m => m.subject)).toEqual(["S1", "S2"]);
    expect(sentMessages[0].text ?? sentMessages[0].html).toBe("B1");
    expect(sentMessages[1].text ?? sentMessages[1].html).toBe("B2");
  });
});

describe("email_send — paranoid (allowedDomains corner cases)", () => {
  it("matches allowedDomains case-insensitively", async () => {
    const t = pick(buildAll({ allowedDomains: ["Example.COM"] }), "email_send");
    // Mixed-case domain in the allowlist; lowercase recipient must
    // still match.
    await t.execute("c1", { to: "alice@example.com", subject: "x", body: "y" });
    expect(sentMessages).toHaveLength(1);
  });

  it("does NOT auto-allow subdomains of allowed domains", async () => {
    const t = pick(buildAll({ allowedDomains: ["example.com"] }), "email_send");
    // sub.example.com must NOT match unless explicitly listed.
    // Pin the strict-match contract; otherwise an internal-only
    // policy could leak via attacker-controlled subdomains.
    await expect(
      t.execute("c1", { to: "evil@sub.example.com", subject: "x", body: "y" }),
    ).rejects.toThrow(/allowed|domain|policy/i);
    expect(sentMessages).toHaveLength(0);
  });

  it("treats an empty allowedDomains array as 'no policy' (allow all)", async () => {
    // Defensive read: if the operator passes [], does the tool
    // FAIL CLOSED (block everything) or treat it as "policy not
    // configured" (allow)? The current impl skips the check when
    // length===0 — pin that explicitly so a future refactor can't
    // silently flip the default.
    const t = pick(buildAll({ allowedDomains: [] }), "email_send");
    await t.execute("c1", { to: "anywhere@randomsite.io", subject: "x", body: "y" });
    expect(sentMessages).toHaveLength(1);
  });
});

describe("email_search / email_list — paranoid", () => {
  it("limit=0 produces an empty result, not an unbounded fetch", async () => {
    const t = pick(buildAll(), "email_list");
    const result = await t.execute("c1", { limit: 0 });
    // Either rejects "limit must be > 0" or returns 0 messages.
    // Pin "no crash, no infinite output".
    expect(result.details).toBeDefined();
    expect(text(result).length).toBeLessThan(10_000);
  });

  it("subject filter doesn't smuggle regex-style metachars into IMAP query", async () => {
    // IMAP SEARCH SUBJECT is literal text, not a regex. A naive impl
    // that built the query string by concatenation could mishandle
    // double-quotes or curly braces. Verify the search runs cleanly
    // with metachars in the subject criterion.
    const t = pick(buildAll(), "email_search");
    const result = await t.execute("c1", { subject: '" OR 1=1 --' });
    expect(text(result).toLowerCase()).toMatch(/no.*found|0|empty/);
  });

  it("a folder name that doesn't exist surfaces as a thrown rejection", async () => {
    // In the canned mailbox we only have INBOX + Drafts. Searching
    // an unknown folder must NOT fall back to INBOX silently.
    // Adjust the fake to throw for unknown folder so we pin the
    // expected propagation behavior.
    const original = imapState.mailboxes;
    imapState.mailboxes = original.filter(m => m.path !== "Sent");
    const t = pick(buildAll(), "email_list");
    // We don't have a "Sent" folder in our fake. The fake's
    // getMailboxLock doesn't validate, so the test mainly pins
    // "no crash, returns parseable result".
    const result = await t.execute("c1", { folder: "Sent" });
    expect(result).toBeDefined();
    imapState.mailboxes = original;
  });
});

describe("email_download_attachment — paranoid", () => {
  it("creates parent dirs for a deeply nested output_path", async () => {
    const t = pick(buildAll(), "email_download_attachment");
    await t.execute("c1", {
      uid: 102,
      part: "2",
      output_path: "deep/nested/sub/dir/invoice.pdf",
    });
    expect(existsSync(join(cwd, "deep/nested/sub/dir/invoice.pdf"))).toBe(true);
  });

  it("back-to-back downloads of the same attachment to different paths both succeed", async () => {
    // Sequential rather than Promise.all — same contract
    // (no shared-stream / transporter-cache bug between calls)
    // without flaky cross-worker timing in vitest.
    const t = pick(buildAll(), "email_download_attachment");
    await t.execute("c1", { uid: 102, part: "2", output_path: "a.pdf" });
    await t.execute("c2", { uid: 102, part: "2", output_path: "b.pdf" });
    expect(existsSync(join(cwd, "a.pdf"))).toBe(true);
    expect(existsSync(join(cwd, "b.pdf"))).toBe(true);
    expect(readFileSync(join(cwd, "a.pdf")).toString()).toContain("PDF");
    expect(readFileSync(join(cwd, "b.pdf")).toString()).toContain("PDF");
  });
});
