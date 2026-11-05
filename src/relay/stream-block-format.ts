import { t } from "../infra/i18n";

export function thinkingHeader(): string {
  return `## 💭 ${t("stream.thinking")}\n\n`;
}
const ARG_MAX_CHARS = 200;
const RESULT_MAX_CHARS = 600;
const RESULT_MAX_LINES = 8;
const ARG_KEYS = ["command", "path", "file_path", "filename", "pattern", "query", "url"] as const;
const TOOL_ICONS: Record<string, string> = {
  bash: "💻",
  read: "📖",
  write: "📝",
  edit: "✏️",
  grep: "🔎",
  search: "🔍",
  find: "🗂️",
  ls: "📁",
  list: "📋",
  web: "🌐",
  fetch: "📡",
  delete: "🗑️",
  remove: "❌",
  todo: "✅",
  test: "🧪",
  qq_send_media: "📤",
};

function backtickFence(text: string, minimum: number): string {
  const runs = text.match(/`+/g) ?? [];
  return "`".repeat(Math.max(minimum, ...runs.map((run) => run.length + 1)));
}

function inlineCode(text: string): string {
  const ticks = backtickFence(text, 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function truncateText(text: string, maxChars: number, maxLines: number): string {
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${out}…` : out;
}

function stringArg(args: unknown, keys: readonly string[]): string | undefined {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
    return undefined;
  }
  if (args !== undefined && args !== null) return String(args);
  return undefined;
}

function rawPrimaryArg(args: unknown, keys: readonly string[] = ARG_KEYS): string | undefined {
  return stringArg(args, keys);
}

function primaryArg(args: unknown): string {
  let value = rawPrimaryArg(args);
  if (!value && args && typeof args === "object") {
    try {
      value = JSON.stringify(args);
    } catch {
      value = String(args);
    }
  }
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > ARG_MAX_CHARS ? `${normalized.slice(0, ARG_MAX_CHARS)}…` : normalized;
}

export interface SkillRead {
  name: string;
}

export function detectSkillRead(toolName: string, args: unknown): SkillRead | undefined {
  if (toolName !== "read" || !args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const rawPath =
    typeof record.path === "string" ? record.path : typeof record.file_path === "string" ? record.file_path : undefined;
  if (!rawPath) return undefined;
  const parts = rawPath.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (parts.length < 2 || parts[parts.length - 1] !== "SKILL.md") return undefined;
  const name = parts[parts.length - 2];
  return name ? { name } : undefined;
}

export function formatSkillBlock(name: string): string {
  return `## 🧩 ${t("stream.skill")}\n\n${inlineCode(name)}\n`;
}

export function formatToolLine(name: string, args: unknown): string {
  const lowerName = name.toLowerCase();
  const label = `${TOOL_ICONS[lowerName] ?? "🔧"} ${name}`;
  const header = `## ${label}`;

  if (lowerName === "bash") {
    const command = rawPrimaryArg(args, ["command"]);
    const formatted = command ? formatBashCommand(command) : "";
    return formatted ? `${header}\n\n${formatted}` : header;
  }

  const primary = primaryArg(args);
  return primary ? `${header}\n\n${inlineCode(primary)}` : header;
}

function formatBashCommand(command: string): string {
  const normalized = command
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (!normalized) return "";
  const fence = backtickFence(normalized, 3);
  return `${fence}bash\n${normalized}\n${fence}`;
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  tex: "latex",
  rst: "rst",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "vue",
  svelte: "svelte",
  json: "json",
  jsonc: "json",
  json5: "json",
  ipynb: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  pyw: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  pl: "perl",
  diff: "diff",
  patch: "diff",
};

function languageForPath(filePath: string): string {
  const base = filePath.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  if (base === "cmakelists.txt") return "cmake";
  if (base === "readme") return "markdown";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXTENSION_LANGUAGES[ext] ?? "text";
}

export function resultLanguage(toolName: string, args: unknown, isError: boolean): string {
  if (isError) return "text";
  if (toolName.toLowerCase() !== "read") return "text";
  const path = rawPrimaryArg(args, ["path", "file_path"]);
  return path ? languageForPath(path) : "text";
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return result === undefined || result === null ? "" : String(result);
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  if (Array.isArray(record.content)) {
    const parts = record.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => block.text);
    if (parts.some((part) => part.trim())) return parts.join("\n");
    if (!structured && parts.length > 0) return "";
  }
  if (typeof structured === "string") return structured;
  if (structured && typeof structured === "object") {
    const output = (structured as Record<string, unknown>).output;
    if (typeof output === "string") return output;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function formatToolResult(result: unknown, isError: boolean, language = "text"): string {
  let text = resultText(result);
  text = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (!text) {
    text = t("stream.noOutput");
    language = "text";
  }
  text = truncateText(text, RESULT_MAX_CHARS, RESULT_MAX_LINES);
  if (isError) text = `❌ ${text}`;
  language = isError || !/^[a-z0-9+#.-]+$/i.test(language) ? "text" : language;
  const fence = backtickFence(text, 3);
  return `${fence}${language}\n${text}\n${fence}\n`;
}
