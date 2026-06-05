/**
 * Static catalog of agent runtime tools (the strings used in an agent's
 * `allowedTools`). Mirrors the `@polpo-ai/tools` package so the dashboard
 * can show the FULL catalog — not just what a given agent has enabled —
 * with human-readable descriptions and per-category metadata.
 *
 * Descriptions are taken from the tool definitions in @polpo-ai/tools.
 * Keep in sync when the package adds/changes tools. (A future
 * GET /v1/tools endpoint will replace this — see todo-tools-catalog-endpoint.)
 *
 * `core: true`  → always available, cannot be disabled (no allowedTools entry needed).
 * `requiresKey` → needs an external credential (vault entry or env var) to run.
 */

export interface CatalogTool {
  name: string;
  description: string;
}

export interface CatalogGroup {
  /** Stable key + the tool-name prefix for non-core groups (e.g. "image_"). */
  key: string;
  /** Display label, e.g. "Image". */
  label: string;
  /** Lucide icon name, resolved to a component in the view. */
  icon: string;
  /** Core groups are always available and have no on/off state. */
  core?: boolean;
  /**
   * Baseline groups are ON by default (when the agent has no `allowedTools`
   * set) but CAN be turned off — they mirror the runtime, which keeps these
   * tools only while `allowedTools` is unset, and filters them otherwise.
   */
  baseline?: boolean;
  /** At least one tool in the group needs an external API key / credential. */
  requiresKey?: boolean;
  /** One-line note about what the group unlocks / requires. */
  note?: string;
  tools: CatalogTool[];
}

export const TOOL_CATALOG: CatalogGroup[] = [
  {
    key: "core",
    label: "Core",
    icon: "ShieldCheck",
    core: true,
    note: "Always on for every agent — vault access and task outcomes. Cannot be disabled.",
    tools: [
      { name: "vault_get", description: "Retrieve credentials for a service from the agent vault." },
      { name: "vault_list", description: "List available vault services (names + key names, no values)." },
      { name: "register_outcome", description: "Register a file, text, URL or data as a task deliverable — the only way to declare outcomes. Task runs only." },
    ],
  },
  {
    key: "fs",
    label: "Coding",
    icon: "Terminal",
    baseline: true,
    note: "Read/write files and run shell commands. On by default — turn tools off to sandbox the agent. (Once you customise tools, only the ones left on here stay available.)",
    tools: [
      { name: "read", description: "Read the contents of a file. Returns line-numbered text; supports offset/limit for large files." },
      { name: "write", description: "Create or overwrite a file. Parent directories are created automatically." },
      { name: "edit", description: "Replace a unique string in a file. The old text must appear exactly once." },
      { name: "bash", description: "Execute a shell command and return its output — tests, packages, git, etc." },
      { name: "glob", description: "Find files matching a glob pattern (**, *, ?, [abc], {a,b})." },
      { name: "grep", description: "Search files for a regex pattern (PCRE). Returns matching lines with paths + line numbers." },
      { name: "ls", description: "List files and directories at a given path." },
    ],
  },
  {
    key: "http_",
    label: "HTTP",
    icon: "Globe",
    baseline: true,
    note: "Outbound HTTP — fetch URLs and download files. SSRF-protected. On by default.",
    tools: [
      { name: "http_fetch", description: "Make an HTTP request (any method, headers, body). Returns status, headers and body. SSRF-protected." },
      { name: "http_download", description: "Download a file from a URL and save it locally." },
    ],
  },
  {
    key: "browser_",
    label: "Browser",
    icon: "Globe",
    note: "Browser automation via the agent-browser runtime.",
    tools: [
      { name: "browser_navigate", description: "Open a URL in the browser. Launches it if not running." },
      { name: "browser_snapshot", description: "Get the accessibility tree with element refs (@e1, @e2) for reliable targeting." },
      { name: "browser_click", description: "Click an element. Use refs from a snapshot." },
      { name: "browser_fill", description: "Clear an input and type new text." },
      { name: "browser_type", description: "Type text into an element without clearing it first." },
      { name: "browser_press", description: "Press a keyboard key, including modifiers (Control+a, Shift+Enter)." },
      { name: "browser_screenshot", description: "Screenshot the current page. Returns the saved image path." },
      { name: "browser_get", description: "Read element text/html/value, page title, or current URL." },
      { name: "browser_select", description: "Select an option from a <select> dropdown." },
      { name: "browser_hover", description: "Hover an element to trigger tooltips or menus." },
      { name: "browser_scroll", description: "Scroll the page to load lazy content or navigate." },
      { name: "browser_wait", description: "Wait for an element, text, URL pattern, or load state." },
      { name: "browser_eval", description: "Run JavaScript in the page context and return the result." },
      { name: "browser_close", description: "Close the browser session (profile data is saved)." },
      { name: "browser_back", description: "Navigate back in browser history." },
      { name: "browser_forward", description: "Navigate forward in browser history." },
      { name: "browser_reload", description: "Reload the current page." },
      { name: "browser_tabs", description: "Manage tabs: list, open, switch, or close." },
    ],
  },
  {
    key: "image_",
    label: "Image",
    icon: "Image",
    requiresKey: true,
    note: "Image generation + vision analysis. Needs a fal / OpenAI / Anthropic key.",
    tools: [
      { name: "image_generate", description: "Generate an image from a text prompt. Model from agent.image_model (default fal/flux/dev)." },
      { name: "image_analyze", description: "Analyze an image with a vision model — describe, OCR, answer questions. Model from agent.vision_model." },
    ],
  },
  {
    key: "video_",
    label: "Video",
    icon: "Video",
    requiresKey: true,
    note: "Video generation. Needs a fal key.",
    tools: [
      { name: "video_generate", description: "Generate a video from a text prompt (MP4). Model from agent.video_model (default luma-ray-2-flash)." },
    ],
  },
  {
    key: "audio_",
    label: "Audio",
    icon: "Volume2",
    requiresKey: true,
    note: "Speech-to-text + text-to-speech. Needs OpenAI / Deepgram / ElevenLabs (Edge TTS is free).",
    tools: [
      { name: "audio_transcribe", description: "Transcribe an audio file to text. Model from agent.transcribe_model (default whisper-1)." },
      { name: "audio_speak", description: "Synthesize speech from text. Model from agent.tts_model (default tts-1; edge is free, no key)." },
    ],
  },
  {
    key: "search_",
    label: "Search",
    icon: "Search",
    note: "Managed web search — runs through the platform (Perplexity via the AI Gateway). No key required.",
    tools: [
      { name: "search_web", description: "Search the web with natural-language queries. Returns titles, URLs and snippets." },
      { name: "search_find_similar", description: "Find web pages similar to a given URL — alternatives, competitors, related resources." },
    ],
  },
  {
    key: "email_",
    label: "Email",
    icon: "Mail",
    requiresKey: true,
    note: "SMTP/IMAP email. Needs mail server credentials.",
    tools: [
      { name: "email_send", description: "Send an email via SMTP. HTML, to/cc/bcc, attachments, reply-to. Domain allowlist enforced." },
      { name: "email_draft", description: "Create a draft by appending a composed message to the IMAP Drafts folder." },
      { name: "email_list", description: "List recent emails from a folder — subject, from, date, UID." },
      { name: "email_read", description: "Read a full email by UID — headers, body, attachment metadata." },
      { name: "email_search", description: "Search the mailbox for messages matching a query." },
      { name: "email_download_attachment", description: "Download a specific attachment from a message to the output directory." },
      { name: "email_verify", description: "Verify SMTP credentials / connectivity before sending." },
      { name: "email_count", description: "Count messages in a mailbox folder." },
    ],
  },
  {
    key: "excel_",
    label: "Spreadsheet",
    icon: "Sheet",
    note: "Spreadsheet (.xlsx / CSV) read + write.",
    tools: [
      { name: "excel_read", description: "Read rows from an Excel/CSV file with column headers. Supports sheet + range." },
      { name: "excel_write", description: "Write structured rows to an Excel/CSV file." },
      { name: "excel_query", description: "Query a spreadsheet with filters/aggregations and return matching rows." },
      { name: "excel_info", description: "Inspect a workbook — sheets, dimensions, column headers." },
    ],
  },
  {
    key: "pdf_",
    label: "PDF",
    icon: "FileText",
    note: "PDF read, create (HTML→PDF), merge.",
    tools: [
      { name: "pdf_read", description: "Extract text from a PDF — all or specific pages." },
      { name: "pdf_create", description: "Render a full HTML document to a professional PDF via Chromium (full CSS support)." },
      { name: "pdf_merge", description: "Merge multiple PDFs into a single document." },
      { name: "pdf_info", description: "Inspect a PDF — page count and metadata." },
    ],
  },
  {
    key: "docx_",
    label: "Docs",
    icon: "FileType",
    note: "Word document (.docx) read + create.",
    tools: [
      { name: "docx_read", description: "Read a .docx and extract content as text, Markdown or HTML (preserves structure)." },
      { name: "docx_create", description: "Create a .docx with headings, paragraphs, lists and bold/italic formatting." },
    ],
  },
  {
    key: "memory_",
    label: "Memory",
    icon: "Brain",
    note: "The agent's own persistent memory across sessions.",
    tools: [
      { name: "memory_get", description: "Read the agent's persistent memory (empty if none yet)." },
      { name: "memory_save", description: "Overwrite the entire persistent memory with new content." },
      { name: "memory_append", description: "Append a timestamped line to the persistent memory." },
      { name: "memory_update", description: "Find-and-replace a unique section in the persistent memory." },
    ],
  },
];

/** Every catalogued tool name, for detecting custom/unknown enabled tools. */
export const CATALOG_TOOL_NAMES = new Set(
  TOOL_CATALOG.flatMap((g) => g.tools.map((t) => t.name)),
);

/**
 * Is `toolName` enabled by an agent's `allowedTools`? True on an exact match
 * or a matching wildcard (e.g. "image_*" enables "image_generate").
 */
export function isToolEnabled(toolName: string, allowed: string[]): boolean {
  if (allowed.includes(toolName)) return true;
  return allowed.some(
    (a) => a.endsWith("*") && toolName.startsWith(a.slice(0, -1)),
  );
}

/** Does `allowed` enable a whole group via its wildcard (e.g. "image_*")? */
export function hasGroupWildcard(groupKey: string, allowed: string[]): boolean {
  return allowed.includes(`${groupKey}*`);
}
