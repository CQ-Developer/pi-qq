export const THINKING_HEADER = "**💭 思考**\n\n";
const ARG_MAX_CHARS = 200;
const RESULT_MAX_CHARS = 600;
const RESULT_MAX_LINES = 8;
const ARG_KEYS = ["command", "path", "file_path", "filename", "pattern", "query", "url"];
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
};

function inlineCode(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const ticks = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
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

function primaryArg(args: unknown): string {
  let value: string | undefined;
  if (typeof args === "string") {
    value = args;
  } else if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    value = ARG_KEYS.map((key) => record[key]).find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    if (!value) {
      try {
        value = JSON.stringify(args);
      } catch {
        value = String(args);
      }
    }
  } else if (args !== undefined && args !== null) {
    value = String(args);
  }
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > ARG_MAX_CHARS ? `${normalized.slice(0, ARG_MAX_CHARS)}…` : normalized;
}

export function formatToolLine(name: string, args: unknown): string {
  const primary = primaryArg(args);
  const label = `${TOOL_ICONS[name.toLowerCase()] ?? "🔧"} ${name}`;
  return primary ? `**${label}**\n\n${inlineCode(primary)}` : `**${label}**`;
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

export function formatToolResult(result: unknown, isError: boolean): string {
  let text = resultText(result);
  text = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (!text) text = "(no output)";
  text = truncateText(text, RESULT_MAX_CHARS, RESULT_MAX_LINES);
  if (isError) text = `❌ ${text}`;
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${text}\n${fence}\n`;
}
