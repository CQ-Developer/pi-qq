import { t } from "../infra/i18n";

export interface AttachmentFailure {
  filename: string;
  reason: string;
}

export function formatAttachmentFailures(failures: readonly AttachmentFailure[], successCount: number): string {
  const title =
    successCount > 0
      ? t("attachments.failedMany", { failed: failures.length, success: successCount })
      : t("attachments.failedNone");
  return [title, ...failures.map((failure) => `• ${failure.filename}: ${failure.reason}`)].join("\n");
}
