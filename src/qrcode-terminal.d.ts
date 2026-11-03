declare module "qrcode-terminal" {
  export function generate(text: string, options?: { small?: boolean }, cb?: (ascii: string) => void): void;
}
