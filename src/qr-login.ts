import { startQrConnect } from "@tencent-connect/qqbot-connector";
import { generate } from "qrcode-terminal";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Credentials } from "./settings";
import { log } from "./file-logger";

export interface QrLoginResult extends Credentials {
  userOpenid?: string;
}

export async function runQrLogin(ctx: ExtensionContext): Promise<QrLoginResult | undefined> {
  const ac = new AbortController();
  log.info("login", "QR login started");

  const qr = { lines: [] as string[], hint: "Fetching QR code…" };
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
        onSuccess: ([first]) => {
          log.info("login", "QR login succeeded", {
            appId: first?.appId ?? null,
            hasOpenid: Boolean(first?.userOpenid),
          });
          finish(first ? { appId: first.appId, appSecret: first.appSecret, userOpenid: first.userOpenid } : undefined);
          closeOverlay?.();
        },
        onFailure: (err) => {
          if (settled) return;
          const cause = (err as { cause?: unknown }).cause;
          log.error("login", "QR login failed", {
            err,
            name: err.name,
            code: (err as NodeJS.ErrnoException).code,
            causeName: cause instanceof Error ? cause.name : undefined,
            causeCode: cause && typeof cause === "object" ? (cause as NodeJS.ErrnoException).code : undefined,
            causeMessage: cause instanceof Error ? cause.message : undefined,
          });
          ctx.ui.notify("Error: QR login failed", "error");
          finish();
          closeOverlay?.();
        },
        onQrDisplayed: (url) => {
          log.debug("login", "QR code displayed");
          qr.hint = "Scan with mobile QQ";
          generate(url, { small: true }, (ascii) => {
            qr.lines = ascii.split("\n").filter((line) => line.trim().length > 0);
          });
          requestRender?.();
          if (ctx.mode !== "tui") ctx.ui.notify(`pi-qq QR URL: ${url}`, "info");
        },
        onQrExpired: () => {
          log.warn("login", "QR code expired; refreshing");
          qr.hint = "QR code expired; refreshing…";
          requestRender?.();
        },
      },
      { displayQrCodeToConsole: false, signal: ac.signal },
    );

    if (ctx.mode !== "tui") {
      ctx.ui.notify("pi-qq: waiting for mobile QQ scan…", "info");
      return;
    }

    void ctx.ui
      .custom<void>((tui, theme, keybindings, done) => {
        closeOverlay = done;
        requestRender = () => tui.requestRender();
        return {
          render(width: number): string[] {
            const lines = qr.lines.length > 0 ? qr.lines : ["(fetching QR code…)"];
            return [...lines, "", qr.hint, theme.fg("dim", "Esc to cancel")].map((line) =>
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
        if (!settled) finish();
      });
  });
}
