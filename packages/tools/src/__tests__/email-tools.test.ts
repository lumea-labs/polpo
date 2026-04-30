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
import type { PolpoTool as AgentTool } from "@polpo-ai/core";
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

function pick(tools: AgentTool<any>[], name: string): AgentTool<any> {
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
});
