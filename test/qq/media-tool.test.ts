import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaFileType, UploadDailyLimitExceededError, type QQBot } from "@tencent-connect/qqbot-nodejs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureI18n } from "../../src/infra/i18n";
import { log } from "../../src/infra/file-logger";
import { ReplyBudget } from "../../src/quota/reply-quota";
import {
  MEDIA_TOOL_NAME,
  prepareMedia,
  registerMediaTool,
  resolveMediaFileType,
  type MediaParams,
  type MediaToolDetails,
} from "../../src/qq/media-tool";

interface UploadArgs {
  target: { scope: string; targetId: string };
  fileType: MediaFileType;
  localPath: string;
  fileName?: string;
  srvSendMsg: boolean;
  onProgress?: (uploaded: number, total: number) => void;
}

interface SendOpts {
  msgId?: string;
  content?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: MediaToolDetails;
}

interface ToolLike {
  execute(
    toolCallId: string,
    params: MediaParams,
    signal: AbortSignal | undefined,
    onUpdate: ((result: ToolResult) => void) | undefined,
    ctx: { cwd: string },
  ): Promise<ToolResult>;
}

let tempDir: string;

beforeEach(async () => {
  configureI18n("zh-cn");
  tempDir = await mkdtemp(join(tmpdir(), "pi-qq-media-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  configureI18n("zh-cn");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makePi() {
  const tools = new Map<string, unknown>();
  const state = { activeTools: ["read", "bash"] };
  const pi = {
    registerTool(tool: { name: string; defaultActive?: boolean }) {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false) state.activeTools.push(tool.name);
    },
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (names: string[]) => {
      state.activeTools = [...names];
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, state };
}

function makeBot() {
  const uploads: UploadArgs[] = [];
  const sends: Array<{ targetId: string; fileInfo: string; opts: SendOpts }> = [];
  const uploadMedia = vi.fn(async (opts: UploadArgs) => {
    uploads.push(opts);
    return { file_uuid: "file-uuid", file_info: "file-info", ttl: 3600 };
  });
  const sendMediaMessage = vi.fn(
    async (_scope: string, targetId: string, fileInfo: string, _creds: unknown, opts: SendOpts) => {
      sends.push({ targetId, fileInfo, opts });
      return { id: `message-${sends.length}`, timestamp: 1 };
    },
  );
  const bot = {
    uploadMedia,
    mediaApi: { sendMediaMessage },
    getCredentials: () => ({ appId: "app", clientSecret: "secret" }),
  } as unknown as QQBot;
  return { bot, uploadMedia, sendMediaMessage, uploads, sends };
}

function makeHarness(options: { target?: boolean } = {}) {
  const { pi, tools, state } = makePi();
  const budget = new ReplyBudget();
  if (options.target !== false) budget.observeInbound("openid-u", "msg-in", Date.now());
  const onWarn = vi.fn();
  const login = { allowedOpenid: "openid-u" };
  const fake = makeBot();
  const controller = registerMediaTool(pi, {
    getBot: () => fake.bot,
    getLogin: () => login,
    budget,
    onWarn,
  });
  const tool = tools.get(MEDIA_TOOL_NAME) as unknown as ToolLike;
  return { controller, tool, budget, onWarn, ...fake, state };
}

async function writeMedia(name: string, content = "data"): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, content);
  return path;
}

describe("media type helpers", () => {
  it("detects image, video, and file extensions", () => {
    expect(resolveMediaFileType("shot.PNG")).toBe(MediaFileType.IMAGE);
    expect(resolveMediaFileType("clip.mp4")).toBe(MediaFileType.VIDEO);
    expect(resolveMediaFileType("report.pdf")).toBe(MediaFileType.FILE);
    expect(resolveMediaFileType("audio.mp3")).toBe(MediaFileType.FILE);
  });

  it("honors explicit kind and rejects mismatched extensions", () => {
    expect(resolveMediaFileType("shot.png", "file")).toBe(MediaFileType.FILE);
    expect(() => resolveMediaFileType("report.pdf", "image")).toThrow(/image/);
    expect(() => resolveMediaFileType("shot.png", "video")).toThrow(/video/);
  });

  it("prepares a relative path, strips @, and sanitizes the display name", async () => {
    await writeMedia("shot.png");
    const prepared = await prepareMedia({ path: "@shot.png" }, tempDir);
    expect(prepared.fileType).toBe(MediaFileType.IMAGE);
    expect(prepared.path).toBe(join(tempDir, "shot.png"));
    expect(prepared.displayName).toBe("shot.png");
    expect(prepared.size).toBe(4);
  });

  it("uses the name override for file media", async () => {
    await writeMedia("report.pdf");
    const prepared = await prepareMedia({ path: "report.pdf", kind: "file", name: "final.pdf" }, tempDir);
    expect(prepared.fileType).toBe(MediaFileType.FILE);
    expect(prepared.displayName).toBe("final.pdf");
  });

  it("rejects missing, directory, empty, oversized, and symlink paths", async () => {
    await expect(prepareMedia({ path: "missing.png" }, tempDir)).rejects.toThrow(/文件不存在/);
    await expect(prepareMedia({ path: "." }, tempDir)).rejects.toThrow(/不是普通文件/);

    const empty = await writeMedia("empty.png", "");
    await expect(prepareMedia({ path: empty }, tempDir)).rejects.toThrow(/文件为空/);

    const big = join(tempDir, "big.png");
    await writeFile(big, "x");
    await truncate(big, 31 * 1024 * 1024);
    await expect(prepareMedia({ path: big }, tempDir)).rejects.toThrow(/上限/);

    const target = await writeMedia("target.png");
    const link = join(tempDir, "link.png");
    await symlink(target, link);
    await expect(prepareMedia({ path: link }, tempDir)).rejects.toThrow(/不是普通文件/);
  });
});

describe("media tool registration", () => {
  it("registers without calling action methods during extension load", () => {
    const registerTool = vi.fn();
    const getActiveTools = vi.fn(() => {
      throw new Error("action methods are unavailable during extension loading");
    });
    const setActiveTools = vi.fn();
    const pi = { registerTool, getActiveTools, setActiveTools } as unknown as ExtensionAPI;
    const fake = makeBot();

    expect(() =>
      registerMediaTool(pi, {
        getBot: () => fake.bot,
        getLogin: () => ({ allowedOpenid: "openid-u" }),
        budget: new ReplyBudget(),
        onWarn: vi.fn(),
      }),
    ).not.toThrow();
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(getActiveTools).not.toHaveBeenCalled();
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("registers inactive and activates/deactivates without touching other tools", () => {
    const { pi, tools, state } = makePi();
    const fake = makeBot();
    const controller = registerMediaTool(pi, {
      getBot: () => fake.bot,
      getLogin: () => ({ allowedOpenid: "openid-u" }),
      budget: new ReplyBudget(),
      onWarn: vi.fn(),
    });

    expect(tools.has(MEDIA_TOOL_NAME)).toBe(true);
    expect(state.activeTools).not.toContain(MEDIA_TOOL_NAME);

    controller.activate();
    expect(state.activeTools).toEqual(["read", "bash", MEDIA_TOOL_NAME]);
    controller.activate();
    expect(state.activeTools).toEqual(["read", "bash", MEDIA_TOOL_NAME]);

    controller.deactivate();
    expect(state.activeTools).toEqual(["read", "bash"]);
    expect(controller.isActive()).toBe(false);
  });
});

describe("media tool execute", () => {
  it("sends passively, commits the reply, and truncates the caption", async () => {
    const h = makeHarness();
    await writeMedia("shot.png", "image-data");

    const result = await h.tool.execute(
      "call-1",
      { path: "shot.png", caption: "x".repeat(5000) },
      undefined,
      undefined,
      { cwd: tempDir },
    );

    expect(h.uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { scope: "c2c", targetId: "openid-u" },
        fileType: MediaFileType.IMAGE,
        localPath: join(tempDir, "shot.png"),
        srvSendMsg: false,
      }),
    );
    expect(h.sendMediaMessage).toHaveBeenCalledWith(
      "c2c",
      "openid-u",
      "file-info",
      { appId: "app", clientSecret: "secret" },
      { msgId: "msg-in", content: "x".repeat(4500) },
    );
    expect(h.budget.snapshot().remaining).toBe(3);
    expect(result.content[0].text).toContain("shot.png");
    expect(result.details).toEqual(expect.objectContaining({ phase: "sent", mode: "passive" }));
  });

  it("logs the key debug phases", async () => {
    const h = makeHarness();
    await writeMedia("shot.png", "image-data");
    const debugSpy = vi.spyOn(log, "debug");

    await h.tool.execute("call-log", { path: "shot.png" }, undefined, undefined, { cwd: tempDir });

    const phases = debugSpy.mock.calls
      .filter(([scope]) => scope === "media")
      .map(([, , data]) => (data as { phase?: string })?.phase);
    expect(phases).toEqual(
      expect.arrayContaining([
        "call.start",
        "validate.ok",
        "upload.start",
        "upload.done",
        "budget",
        "send.start",
        "send.done",
        "call.result",
      ]),
    );
  });

  it("sends proactively when there is no reply target", async () => {
    const h = makeHarness({ target: false });
    await writeMedia("clip.mp4", "video-data");

    const result = await h.tool.execute("call-2", { path: "clip.mp4" }, undefined, undefined, { cwd: tempDir });

    expect(h.sendMediaMessage).toHaveBeenCalledWith(
      "c2c",
      "openid-u",
      "file-info",
      { appId: "app", clientSecret: "secret" },
      { msgId: undefined, content: undefined },
    );
    expect(result.details.mode).toBe("proactive");
    expect(h.budget.snapshot().remaining).toBe(0);
  });

  it("reuses file_info for a proactive retry when passive send fails", async () => {
    const h = makeHarness();
    await writeMedia("shot.png", "image-data");
    h.sendMediaMessage.mockRejectedValueOnce(new Error("passive failed"));

    const result = await h.tool.execute("call-3", { path: "shot.png" }, undefined, undefined, { cwd: tempDir });

    expect(h.uploadMedia).toHaveBeenCalledTimes(1);
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(2);
    expect(h.sendMediaMessage.mock.calls[0][4]).toMatchObject({ msgId: "msg-in" });
    expect(h.sendMediaMessage.mock.calls[1][4]).toEqual({ content: undefined });
    expect(h.onWarn).toHaveBeenCalled();
    expect(h.budget.snapshot().remaining).toBe(4);
    expect(result.details.mode).toBe("proactive");
  });

  it("stops before sending when the signal is aborted during upload", async () => {
    const h = makeHarness();
    await writeMedia("shot.png", "image-data");
    const abort = new AbortController();
    h.uploadMedia.mockImplementationOnce(async () => {
      abort.abort();
      return { file_uuid: "file-uuid", file_info: "file-info", ttl: 3600 };
    });

    await expect(
      h.tool.execute("call-abort", { path: "shot.png" }, abort.signal, undefined, { cwd: tempDir }),
    ).rejects.toThrow(/取消/);
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("maps upload daily-limit errors and skips sending", async () => {
    const h = makeHarness();
    await writeMedia("big.mp4", "video-data");
    h.uploadMedia.mockRejectedValueOnce(new UploadDailyLimitExceededError("big.mp4", 1, "daily limit"));

    await expect(h.tool.execute("call-4", { path: "big.mp4" }, undefined, undefined, { cwd: tempDir })).rejects.toThrow(
      /额度/,
    );
    expect(h.sendMediaMessage).not.toHaveBeenCalled();
  });

  it("does not upload when validation fails", async () => {
    const h = makeHarness();
    await expect(
      h.tool.execute("call-5", { path: "missing.png" }, undefined, undefined, { cwd: tempDir }),
    ).rejects.toThrow(/文件不存在/);
    expect(h.uploadMedia).not.toHaveBeenCalled();
  });

  it("reports not connected when the bot is unavailable", async () => {
    const { pi, tools } = makePi();
    registerMediaTool(pi, {
      getBot: () => undefined,
      getLogin: () => ({ allowedOpenid: "openid-u" }),
      budget: new ReplyBudget(),
      onWarn: vi.fn(),
    });
    const tool = tools.get(MEDIA_TOOL_NAME) as unknown as ToolLike;
    await expect(tool.execute("call-6", { path: "shot.png" }, undefined, undefined, { cwd: tempDir })).rejects.toThrow(
      /未连接/,
    );
  });
});
