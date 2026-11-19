import { createHash } from "node:crypto";

const SHORT_ID_LENGTH = 8;

/**
 * Derive a stable, non-reversible short identifier for logs.
 *
 * QQ message IDs share a long constant head and tail, and only the middle
 * varies. Slicing either edge therefore maps different messages to the same
 * short ID; hashing keeps them distinguishable and hides the raw identifier.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "?";
  return createHash("sha256").update(id).digest("hex").slice(0, SHORT_ID_LENGTH);
}
