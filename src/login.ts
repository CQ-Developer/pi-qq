import { startQrConnect } from "@tencent-connect/qqbot-connector";
import { generate } from "qrcode-terminal";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Credentials } from "./config";

/**
 * F1: QR-code login only.
 * - TUI: show an ASCII QR code in ctx.ui.custom; Esc cancels.
 * - Non-TUI: print the QR URL and poll until the scan completes.
 * Credentials are returned to the caller and kept in memory only.
 */

export interface QrLoginResult extends Credentials {
  /** openid of the scanning user, used as the single bound QQ user */
  userOpenid?: string;
}

export async function runQrLogin(ctx: ExtensionContext): Promise<QrLoginResult | undefined> {
  const ac = new AbortController();

  // Shared QR state so polling callbacks and the TUI component stay decoupled.
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
        // The connector currently returns one entry; iterate for future compatibility.
        onSuccess: ([first]) => {
          finish(first ? { appId: first.appId, appSecret: first.appSecret, userOpenid: first.userOpenid } : undefined);
          closeOverlay?.();
        },
        onFailure: (err) => {
          if (settled) return; // User cancelled (abort); no error toast.
          ctx.ui.notify(`QR login failed: ${err.message}`, "error");
          finish();
          closeOverlay?.();
        },
        onQrDisplayed: (url) => {
          qr.hint = "Scan with mobile QQ";
          generate(url, { small: true }, (ascii) => {
            qr.lines = ascii.split("\n").filter((line) => line.trim().length > 0);
          });
          requestRender?.();
          // Non-TUI mode has no overlay; show the URL.
          if (ctx.mode !== "tui") ctx.ui.notify(`pi-qq QR URL: ${url}`, "info");
        },
        onQrExpired: () => {
          qr.hint = "QR code expired; refreshing…";
          requestRender?.();
        },
      },
      { displayQrCodeToConsole: false, signal: ac.signal },
    );

    if (ctx.mode !== "tui") {
      // Non-TUI: no overlay or cancel affordance; wait for the scan.
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
        // Overlay closed by user; success/failure paths already called finish().
        if (!settled) finish();
      });
  });
}
