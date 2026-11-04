import { beforeEach, describe, expect, it } from "vitest";
import { configureI18n } from "../../src/infra/i18n";
import {
  detectSkillRead,
  formatSkillBlock,
  formatToolLine,
  formatToolResult,
  resultLanguage,
} from "../../src/relay/stream-block-format";

beforeEach(() => configureI18n("zh-cn"));

describe("工具格式化", () => {
  it("标题使用 ##，bash 命令使用 bash 代码块", () => {
    expect(formatToolLine("bash", { command: "npm test" })).toBe("## 💻 bash\n\n```bash\nnpm test\n```");
    expect(formatToolLine("bash", { command: "echo `x`" })).toBe("## 💻 bash\n\n```bash\necho `x`\n```");
    expect(formatToolLine("bash", { command: "   " })).toBe("## 💻 bash");
  });

  it("多行 bash 命令保留换行和缩进，且不截断", () => {
    expect(formatToolLine("bash", { command: "cd frontend &&\n  npm test" })).toBe(
      "## 💻 bash\n\n```bash\ncd frontend &&\n  npm test\n```",
    );
    const longCommand = `echo ${"x".repeat(300)}`;
    expect(formatToolLine("bash", { command: longCommand })).toContain(longCommand);
  });

  it("bash 命令含三反引号时自动加长围栏", () => {
    const result = formatToolLine("bash", { command: "echo ```" });
    expect(result).toContain("````bash");
    expect(result).toContain("echo ```");
  });

  it("非 bash 工具保留行内主参数", () => {
    expect(formatToolLine("read", { path: "src/foo.ts" })).toBe("## 📖 read\n\n`src/foo.ts`");
    expect(formatToolLine("write", { path: "a.ts", content: "x" })).toBe("## 📝 write\n\n`a.ts`");
    expect(formatToolLine("custom", { foo: "bar" })).toBe('## 🔧 custom\n\n`{"foo":"bar"}`');
    expect(formatToolLine("ping", undefined)).toBe("## 🔧 ping");
  });

  it("结果代码块、失败前缀与空结果", () => {
    expect(formatToolResult("12 passed", false)).toBe("```text\n12 passed\n```\n");
    expect(formatToolResult("boom", true)).toBe("```text\n❌ boom\n```\n");
    expect(formatToolResult("", false)).toBe("```text\n（无输出）\n```\n");
    expect(formatToolResult("", true)).toBe("```text\n❌ （无输出）\n```\n");
  });

  it("按语言输出结果代码块，错误和空结果回退 text", () => {
    expect(formatToolResult("# A", false, "markdown")).toBe("```markdown\n# A\n```\n");
    expect(formatToolResult("boom", true, "markdown")).toBe("```text\n❌ boom\n```\n");
    expect(formatToolResult("", false, "markdown")).toBe("```text\n（无输出）\n```\n");
    expect(formatToolResult("x", false, "not a lang!")).toBe("```text\nx\n```\n");
  });

  it("read 结果按文件扩展名选择语言", () => {
    expect(resultLanguage("read", { path: "docs/a.md" }, false)).toBe("markdown");
    expect(resultLanguage("read", { path: "src/main.PY" }, false)).toBe("python");
    expect(resultLanguage("read", { path: "data/a.json" }, false)).toBe("json");
    expect(resultLanguage("read", { path: "index.html" }, false)).toBe("html");
    expect(resultLanguage("read", { path: "a.png" }, false)).toBe("text");
    expect(resultLanguage("read", { path: "Dockerfile" }, false)).toBe("dockerfile");
    expect(resultLanguage("read", { path: "Makefile" }, false)).toBe("makefile");
    expect(resultLanguage("read", { path: "CMakeLists.txt" }, false)).toBe("cmake");
    expect(resultLanguage("read", { path: "README" }, false)).toBe("markdown");
    expect(resultLanguage("read", { file_path: "C:\\docs\\a.ts" }, false)).toBe("typescript");
    expect(resultLanguage("read", { path: "a.md" }, true)).toBe("text");
    expect(resultLanguage("bash", { command: "echo" }, false)).toBe("text");
  });

  it("工具结果对象提取 content 文本", () => {
    const result = {
      content: [{ type: "text", text: "npm test\n3 passed" }],
      structuredContent: { output: "ignored" },
    };
    expect(formatToolResult(result, false)).toBe("```text\nnpm test\n3 passed\n```\n");
    const failed = { content: [{ type: "text", text: "exit code 1" }], structuredContent: { output: "ignored" } };
    expect(formatToolResult(failed, true)).toBe("```text\n❌ exit code 1\n```\n");
    expect(formatToolResult({ structuredContent: "fallback" }, false)).toBe("```text\nfallback\n```\n");
    expect(formatToolResult({ structuredContent: { output: "bash output" } }, false)).toBe(
      "```text\nbash output\n```\n",
    );
  });

  it("结果含三反引号时自动加长围栏", () => {
    expect(formatToolResult("a\n```\nb", false)).toBe("````text\na\n```\nb\n````\n");
    expect(formatToolResult("a\n```\nb", false, "markdown")).toBe("````markdown\na\n```\nb\n````\n");
  });

  it("结果按行与字符截断", () => {
    const manyLines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const result = formatToolResult(manyLines, false);
    expect(result).toContain("line 7");
    expect(result).not.toContain("line 8");
    expect(result).toContain("…");
  });
});

describe("skill formatting", () => {
  it("detects SKILL.md reads", () => {
    expect(detectSkillRead("read", { path: "/home/chen/.pi/agent/skills/playwright-cli/SKILL.md" })).toEqual({
      name: "playwright-cli",
    });
    expect(detectSkillRead("read", { file_path: "C:\\skills\\my-skill\\SKILL.md" })).toEqual({
      name: "my-skill",
    });
    expect(detectSkillRead("read", { path: "src/foo.ts" })).toBeUndefined();
    expect(detectSkillRead("bash", { path: "/tmp/SKILL.md" })).toBeUndefined();
    expect(detectSkillRead("read", { path: "SKILL.md" })).toBeUndefined();
  });

  it("formats a fixed English skill block", () => {
    expect(formatSkillBlock("playwright-cli")).toBe("## 🧩 Skill\n\n`playwright-cli`\n");
  });
});
