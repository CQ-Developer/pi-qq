import { startQrConnect } from "@tencent-connect/qqbot-connector";
import { generate } from "qrcode-terminal";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Credentials } from "../infra/settings";
import { log } from "../infra/file-logger";
import { t } from "../infra/i18n";

export interface QrLoginResult extends Credentials {
  userOpenid?: string;
}

export async function runQrLogin(ctx: ExtensionContext): Promise<QrLoginResult | undefined> {
  const ac = new AbortController();
  log.info("login", "QR login started");

  const qr = { lines: [] as string[], hint: t("login.fetchingQr") };
  let requestRender: (() => void) | undefined;
  let closeOverlay: (() => void) | undefined;

  return new Promise<QrLoginResult | undefined>((resolve) => {
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
          ctx.ui.notify(t("login.failed"), "error");
          finish();
          closeOverlay?.();
        },
        onQrDisplayed: (url) => {
          log.debug("login", "QR code displayed");
          qr.hint = t("login.scan");
          generate(url, { small: true }, (ascii) => {
            qr.lines = ascii.split("\n").filter((line) => line.trim().length > 0);
          });
          requestRender?.();
          if (ctx.mode !== "tui") ctx.ui.notify(t("login.qrUrl", { url }), "info");
        },
        onQrExpired: () => {
          log.warn("login", "QR code expired; refreshing");
          qr.hint = t("login.expired");
          requestRender?.();
        },
      },
      { displayQrCodeToConsole: false, signal: ac.signal },
    );

    if (ctx.mode !== "tui") {
      ctx.ui.notify(t("login.waiting"), "info");
      return;
    }

    void ctx.ui
      .custom<void>((tui, theme, keybindings, done) => {
        closeOverlay = done;
        requestRender = () => tui.requestRender();
        return {
          render(width: number): string[] {
            const lines = qr.lines.length > 0 ? qr.lines : [t("login.fetchingQrShort")];
            return [...lines, "", qr.hint, theme.fg("dim", t("login.cancel"))].map((line) =>
              line.length > width ? line.slice(0, width) : line,
            );
          },
          handleInput(data: string): void {
            if (keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
              // Mark the login settled before aborting: the connector reports an
              // AbortError through onFailure, which must not look like a failure.
              finish();
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
