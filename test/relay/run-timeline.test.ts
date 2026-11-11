import { describe, expect, it } from "vitest";
import { RunTimeline } from "../../src/relay/run-timeline";

function addTools(timeline: RunTimeline, count: number): void {
  for (let i = 0; i < count; i++) {
    timeline.addTool("bash", { command: `cmd-${i}` }, `call-${i}`);
  }
}

describe("RunTimeline", () => {
  it("tracks current thinking, text, and error state", () => {
    const timeline = new RunTimeline();
    timeline.updateAssistant("answer", "thinking");
    expect(timeline.snapshot()).toMatchObject({ text: "answer", thinking: "thinking" });
    expect(timeline.error).toBe(false);

    timeline.finishAssistant("final", true);
    expect(timeline.snapshot()).toMatchObject({ text: "final" });
    expect(timeline.error).toBe(true);
  });

  it("ignores duplicate tool ids", () => {
    const timeline = new RunTimeline();
    expect(timeline.addTool("bash", {}, "call-1")).toBeDefined();
    expect(timeline.addTool("bash", {}, "call-1")).toBeUndefined();
    expect(timeline.diagnostics().toolCount).toBe(1);
  });

  it("serializes tools and keeps only the latest three finished plus the active tool", () => {
    const timeline = new RunTimeline();
    addTools(timeline, 6);
    for (let i = 0; i < 5; i++) {
      const tool = timeline.startNextTool();
      expect(tool?.id).toBe(`call-${i}`);
      timeline.completeTool(`call-${i}`, false, `out-${i}`);
      timeline.finishActiveTool();
    }
    expect(timeline.startNextTool()?.id).toBe("call-5");

    const snapshot = timeline.snapshot();
    expect(snapshot.tools.map((tool) => tool.id)).toEqual(["call-2", "call-3", "call-4", "call-5"]);
    expect(snapshot.tools.at(-1)?.result).toBeUndefined();
    expect(snapshot.tools[0]?.result).toEqual({ isError: false, result: "out-2" });
  });

  it("reports pending tools until all are finished", () => {
    const timeline = new RunTimeline();
    addTools(timeline, 2);
    expect(timeline.hasPendingTools()).toBe(true);
    for (let i = 0; i < 2; i++) {
      timeline.startNextTool();
      timeline.completeTool(`call-${i}`, true, `out-${i}`);
      timeline.finishActiveTool();
    }
    expect(timeline.hasPendingTools()).toBe(false);
  });
});
