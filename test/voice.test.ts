import { describe, expect, it } from "vitest";
import { isVoiceAttachment, resolveVoiceTranscript, type VoiceAttachmentLike } from "../src/voice";

function voice(asr_refer_text?: string, filename = "voice.amr"): VoiceAttachmentLike {
  return {
    content_type: "voice",
    url: "https://example.com/voice",
    filename,
    asr_refer_text,
  };
}

describe("isVoiceAttachment", () => {
  it("recognizes content_type=voice", () => {
    expect(isVoiceAttachment({ content_type: "voice" })).toBe(true);
    expect(isVoiceAttachment({ content_type: "VOICE" })).toBe(true);
  });

  it("does not treat other media or files as voice", () => {
    expect(isVoiceAttachment({ content_type: "audio/amr" })).toBe(false);
    expect(isVoiceAttachment({ content_type: "image/jpeg" })).toBe(false);
    expect(isVoiceAttachment({ content_type: "file" })).toBe(false);
    expect(isVoiceAttachment({})).toBe(false);
  });
});

describe("resolveVoiceTranscript", () => {
  it("returns trimmed ASR text", () => {
    expect(resolveVoiceTranscript([voice("  测试。 ")])).toBe("测试。");
  });

  it("returns undefined for missing or blank ASR", () => {
    expect(resolveVoiceTranscript([voice(undefined)])).toBeUndefined();
    expect(resolveVoiceTranscript([voice("")])).toBeUndefined();
    expect(resolveVoiceTranscript([voice("   ")])).toBeUndefined();
    expect(resolveVoiceTranscript([])).toBeUndefined();
  });

  it("ignores non-voice attachments", () => {
    expect(
      resolveVoiceTranscript([
        { content_type: "file", url: "https://example.com/a.zip", asr_refer_text: "ignored" },
        voice("测试。"),
      ]),
    ).toBe("测试。");
  });

  it("joins multiple voice transcripts in order", () => {
    expect(resolveVoiceTranscript([voice("第一句。"), voice("第二句。")])).toBe("第一句。\n第二句。");
  });
});
