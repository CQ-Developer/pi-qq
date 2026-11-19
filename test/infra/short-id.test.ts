import { describe, expect, it } from "vitest";
import { shortId } from "../../src/infra/short-id";

describe("shortId", () => {
  it("uses the segment after the last underscore", () => {
    expect(
      shortId(
        "ROBOT1.0_UMkNSaLLKokdOorNg7BODxTqCruo2XXP4h5Ksq8uLatL9.q16nvX1V2ZuTRSNOXvi6eb2C6NLoZUoY7nYOihgr3ngGb.Wl-sLP-ZQpRmBmM!",
      ),
    ).toBe("UMkNSaLL");
  });

  it("keeps short ids unchanged", () => {
    expect(shortId("msg-1")).toBe("msg-1");
    expect(shortId("ROBOT1.0")).toBe("ROBOT1.0");
    expect(shortId(undefined)).toBe("?");
    expect(shortId("")).toBe("?");
  });

  it("uses both edges for ids without a separator", () => {
    expect(shortId("0ea26a0f-8e82-44c6-97f6-7598f44d8190")).toBe("0ea2…8190");
  });

  it("is idempotent", () => {
    expect(shortId(shortId("ROBOT1.0_abcdefghijklmnop"))).toBe("abcdefgh");
    expect(shortId(shortId("0ea26a0f-8e82-44c6-97f6-7598f44d8190"))).toBe("0ea2…8190");
  });
});
