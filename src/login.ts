import { startQrConnect } from "@tencent-connect/qqbot-connector";
import { generate } from "qrcode-terminal";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Credentials } from "./config";

/**
 * F1 方式 B：扫码登录。
 * - TUI：ctx.ui.custom 弹窗展示二维码（qrcode-terminal 画 ASCII），Esc 取消；
 *   扫码成功/失败自动关闭弹窗。
 * - 非 TUI：仅提示二维码 URL，后台轮询直到扫码完成（M1 简化，无取消入口）。
 * connector 负责登录协议（生成绑定任务/轮询/解密），本模块只做展示与编排。
 */

export interface QrLoginResult extends Credentials {
  /** 扫码人的 openid（机器人内用户标识），作为默认单人绑定 */
  userOpenid?: string;
}

export async function runQrLogin(ctx: ExtensionContext): Promise<QrLoginResult | undefined> {
  const ac = new AbortController();

  // 二维码展示的共享状态：轮询回调与弹窗组件解耦，render 时读取最新值
  const qr = { lines: [] as string[], hint: "正在获取二维码…" };
  let requestRender: (() => void) | undefined;
  let closeOverlay: (() => void) | undefined;

  return await new Promise<QrLoginResult | undefined>((resolve) => {
    let settled = false;
    const finish = (result?: QrLoginResult) => {
      if (settled) return;
      settled = true;
      stopPolling();
      resolve(result);
    };

    const stopPolling = startQrConnect(
      {
        // 官方说明：返回数组当前恒为 1 个元素，按遍历处理以兼容未来多机器人
        onSuccess: ([first]) => {
          finish(first ? { appId: first.appId, appSecret: first.appSecret, userOpenid: first.userOpenid } : undefined);
          closeOverlay?.();
        },
        onFailure: (err) => {
          if (settled) return; // 用户取消（abort）导致的失败不必提示
          ctx.ui.notify(`扫码登录失败：${err.message}`, "error");
          finish();
          closeOverlay?.();
        },
        onQrDisplayed: (url) => {
          qr.hint = "请用手机 QQ 扫码";
          generate(url, { small: true }, (ascii) => {
            qr.lines = ascii.split("\n").filter((line) => line.trim().length > 0);
          });
          requestRender?.();
          // 非 TUI 模式拿不到弹窗，至少给出 URL
          if (ctx.mode !== "tui") ctx.ui.notify(`pi-qq 扫码地址：${url}`, "info");
        },
        onQrExpired: () => {
          qr.hint = "二维码已过期，正在自动刷新…";
          requestRender?.();
        },
      },
      { displayQrCodeToConsole: false, signal: ac.signal },
    );

    if (ctx.mode !== "tui") {
      // 非 TUI：无弹窗、无取消入口，等待扫码完成（M1 简化）
      ctx.ui.notify("pi-qq：等待手机 QQ 扫码…", "info");
      return;
    }

    void ctx.ui
      .custom<void>((tui, theme, keybindings, done) => {
        closeOverlay = done;
        requestRender = () => tui.requestRender();
        return {
          render(width: number): string[] {
            const lines = qr.lines.length > 0 ? qr.lines : ["（获取二维码中…）"];
            return [...lines, "", qr.hint, theme.fg("dim", "Esc 取消扫码")].map((line) =>
              line.length > width ? line.slice(0, width) : line,
            );
          },
          handleInput(data: string): void {
            if (keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
              ac.abort();
              done();
            }
          },
          invalidate(): void {},
        };
      })
      .then(() => {
        // 弹窗因用户取消而关闭；成功/失败路径已先 finish
        if (!settled) finish();
      });
  });
}
