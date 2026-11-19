const SHORT_ID_LENGTH = 8;
const EDGE_LENGTH = 4;

/**
 * Shorten platform identifiers for logs and diagnostics.
 *
 * QQ message IDs share a constant `ROBOT1.0_` prefix, so a plain prefix slice
 * carries no information. The part after the last underscore is the only
 * distinguishing segment.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "?";
  const separator = id.lastIndexOf("_");
  if (separator >= 0) {
    const suffix = id.slice(separator + 1);
    if (suffix) return suffix.slice(0, SHORT_ID_LENGTH);
  }
  if (id.length <= SHORT_ID_LENGTH) return id;
  return `${id.slice(0, EDGE_LENGTH)}…${id.slice(-EDGE_LENGTH)}`;
}
