export interface AttachmentFailure {
  filename: string;
  reason: string;
}

export function formatAttachmentFailures(failures: readonly AttachmentFailure[], successCount: number): string {
  const title =
    successCount > 0
      ? `⚠️ ${failures.length} attachment(s) failed (${successCount} succeeded):`
      : "⚠️ Attachment failed:";
  return [title, ...failures.map((failure) => `• ${failure.filename}: ${failure.reason}`)].join("\n");
}
