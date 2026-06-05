"use client";

import { useState } from "react";
import { Paperclip, FileText, Image as ImageIcon, FileSpreadsheet, Copy, Check } from "lucide-react";
import type { Attachment, ContentPart, Message } from "./view";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <ImageIcon className="h-3.5 w-3.5" />;
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) return <FileSpreadsheet className="h-3.5 w-3.5" />;
  return <FileText className="h-3.5 w-3.5" />;
}

/** Extract plain text from content (string or ContentPart[]) */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

/** Extract non-text parts (images, files) */
function extractParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  return content.filter((p) => p.type !== "text");
}

export default function RawView({ messages, attachments, projectId }: { messages: Message[]; attachments: Attachment[]; projectId: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Tracks which "<rowId>:<field>" key was most recently copied so the
  // matching button can flash a checkmark for 1.5s. Single string keeps
  // the state tiny vs. a Set + per-block timers.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const copyValue = async (e: React.MouseEvent, value: string, key: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; silently swallow.
    }
  };

  // Flatten: messages + their tool calls as separate rows
  interface RawRow {
    id: string;
    type: "message" | "tool_call";
    role?: string;
    ts: string;
    name?: string;
    content?: string;
    contentParts?: ContentPart[];
    state?: string;
    args?: Record<string, unknown>;
    argsStr?: string;
    result?: string;
    parentId?: string;
    messageId?: string;
    attachments?: Attachment[];
  }

  const rows: RawRow[] = [];
  const firstUserIdx = messages.findIndex(m => m.role === "user");

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    // Collect attachments for this message
    const msgAtts = attachments.filter(a => a.messageId === msg.id);
    const unlinked = mi === firstUserIdx ? attachments.filter(a => !a.messageId) : [];
    const allAtts = [...msgAtts, ...unlinked];

    const textContent = extractText(msg.content);
    const contentParts = extractParts(msg.content);

    // An assistant message that starts with `Error:` is the way the
    // runner surfaces a failed LLM call into the session transcript.
    // Without flagging it as `state: "error"` here, the row renders
    // with a neutral "—" badge and looks identical to a normal
    // assistant reply — making it easy to scroll past. Tagging it
    // turns on the red dot + error styling that tool errors already
    // use, so a failed session is visually obvious.
    const isAssistantError = msg.role === "assistant"
      && typeof textContent === "string"
      && /^\s*Error:\s/i.test(textContent);

    rows.push({
      id: msg.id,
      type: "message",
      role: msg.role,
      ts: msg.ts,
      content: textContent || undefined,
      contentParts: contentParts.length > 0 ? contentParts : undefined,
      state: isAssistantError ? "error" : undefined,
      messageId: msg.id,
      attachments: allAtts.length > 0 ? allAtts : undefined,
    });
    if (msg.toolCalls) {
      for (let ti = 0; ti < msg.toolCalls.length; ti++) {
        const tc = msg.toolCalls[ti];
        rows.push({
          id: tc.id || `${msg.id}-tc-${ti}`,
          type: "tool_call",
          ts: msg.ts,
          name: tc.name,
          state: tc.state || undefined,
          args: tc.arguments,
          argsStr: tc.arguments ? JSON.stringify(tc.arguments, null, 2) : undefined,
          result: tc.result || undefined,
          content: undefined,
          parentId: msg.id,
          messageId: msg.id,
        });
      }
    }
  }

  return (
    <div className="border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium w-16">Type</th>
            <th className="px-3 py-2 text-left font-medium w-28">Role / Tool</th>
            <th className="px-3 py-2 text-left font-medium w-20">Time</th>
            <th className="px-3 py-2 text-left font-medium w-20">State</th>
            <th className="px-3 py-2 text-left font-medium w-48 hidden md:table-cell">Summary</th>
            <th className="px-3 py-2 text-left font-medium">Content / Result</th>
            <th className="px-3 py-2 text-left font-medium w-40">Attachments</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((row) => {
            const isExpanded = expanded.has(row.id);
            const isToolCall = row.type === "tool_call";

            return (
              <tr
                key={row.id}
                onClick={() => toggle(row.id)}
                className={`border-b border-border last:border-0 cursor-pointer transition-colors hover:bg-muted/20 ${
                  isToolCall ? "bg-muted/10" : ""
                }`}
              >
                <td className="px-3 py-2 align-top">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    isToolCall
                      ? "bg-purple-500/10 text-purple-400"
                      : row.role === "user"
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-green-500/10 text-green-400"
                  }`}>
                    {isToolCall ? "tool" : "msg"}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-muted-foreground">
                  {isToolCall ? row.name : row.role}
                </td>
                <td className="px-3 py-2 align-top text-muted-foreground/60">
                  {new Date(row.ts).toLocaleTimeString("en-US", {
                    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                  })}
                </td>
                <td className="px-3 py-2 align-top">
                  {row.state ? (
                    <span className={`inline-flex items-center gap-1 text-[10px] ${
                      row.state === "completed" ? "text-green-500" : row.state === "error" ? "text-red-400" : "text-yellow-500"
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        row.state === "completed" ? "bg-green-500" : row.state === "error" ? "bg-red-500" : "bg-yellow-500"
                      }`} />
                      {row.state}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/30">—</span>
                  )}
                </td>
                {/* Summary — key args or content preview, always visible */}
                <td className="px-3 py-2 align-top text-muted-foreground/70 hidden md:table-cell">
                  {isToolCall && row.args ? (
                    <span className="truncate block">
                      {(row.args as Record<string, unknown>).path as string
                        || (row.args as Record<string, unknown>).command as string
                        || (row.args as Record<string, unknown>).pattern as string
                        || (row.args as Record<string, unknown>).url as string
                        || (row.args as Record<string, unknown>).content
                          ? `${String(Object.values(row.args)[0]).substring(0, 40)}`
                          : Object.keys(row.args).join(", ")
                      }
                    </span>
                  ) : !isToolCall && row.content ? (
                    <span className="truncate block">
                      {row.content.substring(0, 50)}{row.content.length > 50 ? "…" : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/20">—</span>
                  )}
                </td>
                {/* Content / Result — expandable */}
                <td className="px-3 py-2 align-top">
                  {isExpanded ? (
                    <div className="space-y-3 pb-2">
                      {/* ID — click to copy */}
                      <div className="flex gap-2 text-[10px]">
                        <span className="text-muted-foreground/40 uppercase w-12 shrink-0">id</span>
                        <button
                          type="button"
                          onClick={(e) => copyValue(e, row.id, `${row.id}:id`)}
                          className="group inline-flex items-center gap-1.5 text-muted-foreground/60 hover:text-foreground break-all text-left"
                          title="Click to copy id"
                        >
                          <span className="break-all">{row.id}</span>
                          {copiedKey === `${row.id}:id` ? (
                            <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                          ) : (
                            <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                          )}
                        </button>
                      </div>
                      {/* Content (messages) — red on error, hover-copy button */}
                      {row.content && (
                        <div className="group/block relative">
                          <span className={`text-[10px] uppercase tracking-wider ${row.state === "error" ? "text-red-400" : "text-muted-foreground"}`}>
                            {row.state === "error" ? "error" : "content"}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => copyValue(e, row.content!, `${row.id}:content`)}
                            className="absolute right-1 top-3 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 group-hover/block:opacity-100 hover:text-foreground transition-opacity"
                            title="Copy content"
                          >
                            {copiedKey === `${row.id}:content` ? (
                              <><Check className="h-3 w-3 text-emerald-500" /> copied</>
                            ) : (
                              <><Copy className="h-3 w-3" /> copy</>
                            )}
                          </button>
                          <pre className={`mt-1 whitespace-pre-wrap break-words rounded bg-muted/50 p-2 max-h-60 overflow-auto ${
                            row.state === "error" ? "text-red-400" : "text-foreground"
                          }`}>{row.content}</pre>
                        </div>
                      )}
                      {/* File/image parts */}
                      {row.contentParts && row.contentParts.length > 0 && (
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">parts</span>
                          <div className="mt-1 space-y-1">
                            {row.contentParts.map((part, pi) => (
                              <div key={pi} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5">
                                {part.type === "image_url" && (
                                  <>
                                    <ImageIcon className="h-3 w-3 text-blue-400" />
                                    <a href={part.image_url?.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">{part.image_url?.url}</a>
                                  </>
                                )}
                                {part.type === "file" && (
                                  <>
                                    <FileText className="h-3 w-3 text-amber-400" />
                                    <span className="font-mono text-amber-400">{part.file?.filename ?? part.file?.path}</span>
                                    {part.file?.mimeType && <span className="text-muted-foreground/40">{part.file.mimeType}</span>}
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* Args (tool calls) — hover-copy */}
                      {row.argsStr && (
                        <div className="group/block relative">
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">arguments</span>
                          <button
                            type="button"
                            onClick={(e) => copyValue(e, row.argsStr!, `${row.id}:args`)}
                            className="absolute right-1 top-3 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 group-hover/block:opacity-100 hover:text-foreground transition-opacity"
                            title="Copy arguments"
                          >
                            {copiedKey === `${row.id}:args` ? (
                              <><Check className="h-3 w-3 text-emerald-500" /> copied</>
                            ) : (
                              <><Copy className="h-3 w-3" /> copy</>
                            )}
                          </button>
                          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-muted-foreground max-h-40 overflow-auto">{row.argsStr}</pre>
                        </div>
                      )}
                      {/* Result (tool calls) — hover-copy */}
                      {row.result && (
                        <div className="group/block relative">
                          <span className={`text-[10px] uppercase tracking-wider ${row.state === "error" ? "text-red-400" : "text-muted-foreground"}`}>
                            {row.state === "error" ? "error" : "result"}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => copyValue(e, row.result!, `${row.id}:result`)}
                            className="absolute right-1 top-3 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 group-hover/block:opacity-100 hover:text-foreground transition-opacity"
                            title="Copy result"
                          >
                            {copiedKey === `${row.id}:result` ? (
                              <><Check className="h-3 w-3 text-emerald-500" /> copied</>
                            ) : (
                              <><Copy className="h-3 w-3" /> copy</>
                            )}
                          </button>
                          <pre className={`mt-1 whitespace-pre-wrap break-words rounded bg-muted/50 p-2 max-h-60 overflow-auto ${
                            row.state === "error" ? "text-red-400" : "text-muted-foreground"
                          }`}>{row.result}</pre>
                        </div>
                      )}
                      {/* No data */}
                      {!row.content && !row.argsStr && !row.result && (
                        <span className="text-muted-foreground/40 italic">No data</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground truncate block">
                      {isToolCall
                        ? row.result
                          ? row.result.substring(0, 80) + (row.result.length > 80 ? "…" : "")
                          : (<span className="text-muted-foreground/30 italic">no result</span>)
                        : row.content
                          ? row.content.substring(0, 100) + (row.content.length > 100 ? "…" : "")
                          : (<span className="text-muted-foreground/30 italic">empty</span>)
                      }
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  {row.attachments && row.attachments.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {row.attachments.map(att => (
                        <a
                          key={att.id}
                          href={`${process.env.NEXT_PUBLIC_API_URL}/v1/projects/${projectId}/data/v1/attachments/${att.id}/download`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                        >
                          <Paperclip className="h-2.5 w-2.5" />
                          <span className="font-mono">{att.filename}</span>
                          <span className="text-muted-foreground/40">{formatBytes(att.size)}</span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground/20">&mdash;</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
