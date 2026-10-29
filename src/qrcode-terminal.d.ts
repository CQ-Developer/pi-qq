/** qrcode-terminal 无自带类型声明（CJS 包，此处仅声明用到的 API）。 */
declare module "qrcode-terminal" {
  export function generate(text: string, options?: { small?: boolean }, cb?: (ascii: string) => void): void;
  export function setErrorLevel(level: number): void;
}
