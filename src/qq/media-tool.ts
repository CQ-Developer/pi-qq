import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ApiError,
  MediaFileType,
  UploadDailyLimitExceededError,
  getMaxUploadSize,
  sanitizeFileName,
  type QQBot,
  type UploadMediaResponse,
} from "@tencent-connect/qqbot-nodejs";
import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { formatBytes } from "../infra/display-format";
import { log } from "../infra/file-logger";
import { t } from "../infra/i18n";
import type { ReplyBudget } from "../quota/reply-quota";
import { TEXT_CHUNK_LIMIT } from "./reply-sender";

export const MEDIA_TOOL_NAME = "qq_send_media";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"]);

export const mediaParams = Type.Object({
  path: Type.String({ description: "Local image/video/file path, absolute or relative to cwd." }),
  kind: Type.Optional(StringEnum(["auto", "image", "video", "file"] as const)),
  caption: Type.Optional(Type.String({ description: "Optional caption shown with the media." })),
  name: Type.Optional(Type.String({ description: "Display filename for kind=file." })),
});

export type MediaParams = Static<typeof mediaParams>;

export interface MediaToolDetails {
  phase: string;
  path?: string;
  fileType?: MediaFileType;
  sizeBytes?: number;
  displayName?: string;
  mode?: "passive" | "proactive";
  messageId?: string;
  fileUuid?: string;
  ttlSec?: number;
  elapsedMs?: number;
  uploaded?: number;
  total?: number;
}

interface PreparedMedia {
  path: string;
  fileType: MediaFileType;
  size: number;
  displayName: string;
  details: MediaToolDetails;
}

interface MediaToolLogin {
  allowedOpenid: string;
}

export interface MediaToolDeps {
  getBot: () => QQBot | undefined;
  getLogin: () => MediaToolLogin | undefined;
  budget: ReplyBudget;
  onWarn: (message: string) => void;
}

export interface MediaToolController {
  activate(): void;
  deactivate(): void;
}

function mediaErrorMessage(err: unknown): Error {
  if (err instanceof UploadDailyLimitExceededError) {
    return new Error(t("mediaTool.uploadDailyLimit", { message: err.message }));
  }
  if (err instanceof ApiError) {
    return new Error(
      t("mediaTool.apiFailed", {
        code: err.bizCode ?? "unknown",
        message: err.bizMessage ?? err.message,
      }),
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function mediaKindLabel(fileType: MediaFileType): string {
  if (fileType === MediaFileType.IMAGE) return t("mediaTool.kindImage");
  if (fileType === MediaFileType.VIDEO) return t("mediaTool.kindVideo");
  return t("mediaTool.kindFile");
}

export function normalizeMediaPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return resolve(cwd, withoutAt);
}

export function resolveMediaFileType(filePath: string, kind: MediaParams["kind"] = "auto"): MediaFileType {
  const extension = extname(filePath).toLowerCase();
  if (kind === "image") {
    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(t("mediaTool.unsupportedKind", { kind: "image", path: filePath }));
    }
    return MediaFileType.IMAGE;
  }
  if (kind === "video") {
    if (!VIDEO_EXTENSIONS.has(extension)) {
      throw new Error(t("mediaTool.unsupportedKind", { kind: "video", path: filePath }));
    }
    return MediaFileType.VIDEO;
  }
  if (kind === "file") return MediaFileType.FILE;
  if (IMAGE_EXTENSIONS.has(extension)) return MediaFileType.IMAGE;
  if (VIDEO_EXTENSIONS.has(extension)) return MediaFileType.VIDEO;
  return MediaFileType.FILE;
}

export async function prepareMedia(params: MediaParams, cwd: string): Promise<PreparedMedia> {
  const filePath = normalizeMediaPath(cwd, params.path);
  let info: Stats;
  try {
    info = await lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(t("mediaTool.notFound", { path: filePath }), { cause: err });
    }
    throw err;
  }

  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(t("mediaTool.notRegularFile", { path: filePath }));
  }
  if (info.size === 0) {
    throw new Error(t("mediaTool.emptyFile", { path: filePath }));
  }

  const fileType = resolveMediaFileType(filePath, params.kind ?? "auto");
  const maxSize = getMaxUploadSize(fileType);
  if (info.size > maxSize) {
    throw new Error(
      t("mediaTool.tooLarge", {
        size: formatBytes(info.size),
        limit: formatBytes(maxSize),
      }),
    );
  }

  const rawName = params.name?.trim() ? basename(params.name) : basename(filePath);
  const displayName = sanitizeFileName(rawName);
  return {
    path: filePath,
    fileType,
    size: info.size,
    displayName,
    details: {
      phase: "prepared",
      path: filePath,
      fileType,
      sizeBytes: info.size,
      displayName,
    },
  };
}

function createTool(deps: MediaToolDeps): ToolDefinition<typeof mediaParams, MediaToolDetails> {
  return {
    name: MEDIA_TOOL_NAME,
    label: "Send to QQ",
    description:
      "Send a local image, video, or file to the bound QQ private chat. " +
      "Call only when the user explicitly asks to send media back to QQ. " +
      "If the request is ambiguous, ask the user before calling.",
    promptSnippet: "Send a local image, video, or file back to the user's QQ chat",
    promptGuidelines: [
      "Use qq_send_media only when the user explicitly asks to send an image, video, or file back to QQ.",
      "Never call qq_send_media proactively after generating, editing, or reading a file; report the local path instead.",
      "If you are unsure whether the user wants the file sent to QQ, ask them first; do not call the tool.",
    ],
    parameters: mediaParams,
    defaultActive: false,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const startedAt = Date.now();
      log.debug("media", "media tool", {
        phase: "call.start",
        toolCallId,
        path: params.path,
        kind: params.kind ?? "auto",
        captionLength: params.caption?.length ?? 0,
      });

      const bot = deps.getBot();
      const login = deps.getLogin();
      if (!bot || !login) {
        log.debug("media", "media tool", {
          phase: "not.connected",
          toolCallId,
          hasBot: Boolean(bot),
          hasLogin: Boolean(login),
        });
        throw new Error(t("mediaTool.notConnected"));
      }
      if (signal?.aborted) {
        log.debug("media", "media tool", { phase: "aborted", toolCallId });
        throw new Error(t("mediaTool.cancelled"));
      }

      let prepared: PreparedMedia;
      try {
        prepared = await prepareMedia(params, ctx.cwd);
      } catch (err) {
        log.debug("media", "media tool", {
          phase: "validate.fail",
          toolCallId,
          path: params.path,
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      log.debug("media", "media tool", {
        phase: "validate.ok",
        toolCallId,
        fileType: prepared.fileType,
        sizeBytes: prepared.size,
        displayName: prepared.displayName,
      });

      let upload: UploadMediaResponse;
      const uploadStartedAt = Date.now();
      try {
        log.debug("media", "media tool", {
          phase: "upload.start",
          toolCallId,
          fileType: prepared.fileType,
          sizeBytes: prepared.size,
          path: prepared.path,
        });
        upload = await bot.uploadMedia({
          target: { scope: "c2c", targetId: login.allowedOpenid },
          fileType: prepared.fileType,
          localPath: prepared.path,
          fileName: prepared.fileType === MediaFileType.FILE ? prepared.displayName : undefined,
          srvSendMsg: false,
          onProgress: (uploaded, total) => {
            onUpdate?.({
              content: [{ type: "text", text: `Uploading ${Math.round((uploaded / total) * 100)}%` }],
              details: { ...prepared.details, phase: "upload", uploaded, total },
            });
          },
        });
        log.debug("media", "media tool", {
          phase: "upload.done",
          toolCallId,
          fileUuid: upload.file_uuid,
          ttlSec: upload.ttl,
          elapsedMs: Date.now() - uploadStartedAt,
        });
      } catch (err) {
        const mapped = mediaErrorMessage(err);
        log.warn("media", "media tool", { phase: "call.error", toolCallId, stage: "upload", err });
        throw mapped;
      }

      if (signal?.aborted) {
        log.debug("media", "media tool", { phase: "aborted", toolCallId, stage: "upload" });
        throw new Error(t("mediaTool.cancelled"));
      }

      const reply = deps.budget.acquire();
      const snapshot = deps.budget.snapshot();
      const msgId = reply.mode === "passive" ? reply.msgId : undefined;
      const targetId = reply.openid ?? login.allowedOpenid;
      const caption = params.caption?.slice(0, TEXT_CHUNK_LIMIT);

      log.debug("media", "media tool", {
        phase: "budget",
        toolCallId,
        mode: reply.mode,
        msgId: msgId ?? null,
        remaining: snapshot.remaining,
        fresh: snapshot.fresh,
      });

      const sendStartedAt = Date.now();
      log.debug("media", "media tool", {
        phase: "send.start",
        toolCallId,
        mode: reply.mode,
        targetId,
        msgId: msgId ?? null,
        fileType: prepared.fileType,
        captionLength: caption?.length ?? 0,
      });

      const sendMedia = (target: string, passiveMsgId?: string) =>
        bot.mediaApi.sendMediaMessage("c2c", target, upload.file_info, bot.getCredentials(), {
          ...(passiveMsgId ? { msgId: passiveMsgId } : {}),
          content: caption,
        });
      const buildResult = (
        messageId: string,
        mode: "passive" | "proactive",
        elapsedMs: number,
      ): { content: Array<{ type: "text"; text: string }>; details: MediaToolDetails } => ({
        content: [
          {
            type: "text",
            text: t("mediaTool.sent", {
              kind: mediaKindLabel(prepared.fileType),
              name: prepared.displayName,
              mode: t(mode === "passive" ? "mediaTool.modePassive" : "mediaTool.modeProactive"),
            }),
          },
        ],
        details: {
          ...prepared.details,
          phase: "sent",
          mode,
          messageId,
          fileUuid: upload.file_uuid,
          ttlSec: upload.ttl,
          elapsedMs,
        },
      });

      try {
        const message = await sendMedia(targetId, msgId);
        if (msgId) deps.budget.commitPassive(msgId);
        const elapsedMs = Date.now() - sendStartedAt;
        log.debug("media", "media tool", {
          phase: "send.done",
          toolCallId,
          mode: reply.mode,
          messageId: message.id,
          elapsedMs,
        });
        log.debug("media", "media tool", {
          phase: "call.result",
          toolCallId,
          ok: true,
          mode: reply.mode,
          messageId: message.id,
        });
        return buildResult(message.id, reply.mode, Date.now() - startedAt);
      } catch (err) {
        if (!msgId) {
          log.warn("media", "media tool", { phase: "call.error", toolCallId, stage: "send", err });
          throw mediaErrorMessage(err);
        }

        log.warn("media", "media tool", {
          phase: "send.passiveFailed",
          toolCallId,
          msgId,
          err,
        });
        log.warn("media", "media tool", {
          phase: "send.proactiveRetry",
          toolCallId,
          targetId: login.allowedOpenid,
        });

        try {
          const message = await sendMedia(login.allowedOpenid);
          deps.onWarn(t("outbound.passiveFailed"));
          const elapsedMs = Date.now() - sendStartedAt;
          log.debug("media", "media tool", {
            phase: "send.done",
            toolCallId,
            mode: "proactive",
            messageId: message.id,
            elapsedMs,
          });
          log.debug("media", "media tool", {
            phase: "call.result",
            toolCallId,
            ok: true,
            mode: "proactive",
            messageId: message.id,
          });
          return buildResult(message.id, "proactive", Date.now() - startedAt);
        } catch (retryErr) {
          log.warn("media", "media tool", {
            phase: "call.error",
            toolCallId,
            stage: "proactiveRetry",
            err: retryErr,
          });
          throw mediaErrorMessage(retryErr);
        }
      }
    },
  };
}

export function registerMediaTool(pi: ExtensionAPI, deps: MediaToolDeps): MediaToolController {
  pi.registerTool(createTool(deps));
  log.debug("media", "media tool", {
    phase: "tool.registered",
    defaultActive: false,
  });

  return {
    activate() {
      const active = pi.getActiveTools();
      if (!active.includes(MEDIA_TOOL_NAME)) {
        pi.setActiveTools([...new Set([...active, MEDIA_TOOL_NAME])]);
      }
      log.debug("media", "media tool", {
        phase: "tool.activate",
        active: true,
        activeCount: pi.getActiveTools().length,
      });
    },
    deactivate() {
      const active = pi.getActiveTools();
      const removed = active.includes(MEDIA_TOOL_NAME);
      if (removed) {
        pi.setActiveTools(active.filter((name) => name !== MEDIA_TOOL_NAME));
      }
      log.debug("media", "media tool", {
        phase: "tool.deactivate",
        active: false,
        removed,
        activeCount: pi.getActiveTools().length,
      });
    },
  };
}
