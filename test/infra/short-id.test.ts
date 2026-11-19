import { describe, expect, it } from "vitest";
import { shortId } from "../../src/infra/short-id";

const MESSAGE_A =
  "ROBOT1.0_UMkNSaLLKokdOorNg7BODxTqCruo2XXP4h5Ksq8uLatL9.q16nvX1V2ZuTRSNOXvi6eb2C6NLoZUoY7nYOihgr3ngGb.Wl-sLP-ZQpRmBmM!";
const MESSAGE_B =
  "ROBOT1.0_UMkNSaLLKokdOorNg7BODyQVUYU63qiEc2CwGsfDBhhlsIA56i8mDiCA1PMqn8idJcMG3.B7swIy7f6eE2x3brK7vOIcYRDE9IfsMXwqNnE!";

describe("shortId", () => {
  it("distinguishes messages that share the constant head and tail", () => {
    expect(shortId(MESSAGE_A)).toBe("a98bf36d");
    expect(shortId(MESSAGE_B)).toBe("72510c7e");
    expect(shortId(MESSAGE_A)).not.toBe(shortId(MESSAGE_B));
  });

  it("returns a stable 8-character hex id", () => {
    expect(shortId("0ea26a0f-8e82-44c6-97f6-7598f44d8190")).toMatch(/^[0-9a-f]{8}$/);
    expect(shortId("0ea26a0f-8e82-44c6-97f6-7598f44d8190")).toBe("cb0617ca");
    expect(shortId(MESSAGE_A)).toBe(shortId(MESSAGE_A));
  });

  it("handles empty identifiers", () => {
    expect(shortId(undefined)).toBe("?");
    expect(shortId("")).toBe("?");
  });
});
