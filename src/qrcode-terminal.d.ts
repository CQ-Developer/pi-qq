/** qrcode-terminal has no bundled types (CJS); declare only the API we use. */
declare module "qrcode-terminal" {
  export function generate(text: string, options?: { small?: boolean }, cb?: (ascii: string) => void): void;
  export function setErrorLevel(level: number): void;
}
