import { detectSkillRead } from "./stream-block-format";

export interface TimelineTool {
  id: string;
  name: string;
  args?: unknown;
  result?: { isError: boolean; result?: unknown };
  skillName?: string;
  startedAt: number;
  finishedAt?: number;
  started: boolean;
  finished: boolean;
}

interface RunSnapshot {
  thinking: string;
  text: string;
  tools: TimelineTool[];
}

const MAX_SNAPSHOT_TOOLS = 5;
const MAX_SNAPSHOT_FINISHED_TOOLS = 3;

export class RunTimeline {
  private tools: TimelineTool[] = [];
  private activeToolId?: string;
  private thinking = "";
  private text = "";
  private hadError = false;

  updateAssistant(text: string, thinking: string): void {
    if (text.trim()) this.text = text;
    this.thinking = thinking;
  }

  finishAssistant(text: string, isError: boolean): void {
    if (text.trim()) this.text = text;
    if (isError) this.hadError = true;
  }

  addTool(toolName: string, args: unknown, toolCallId: string): TimelineTool | undefined {
    if (this.tools.some((tool) => tool.id === toolCallId)) return undefined;
    const skill = detectSkillRead(toolName, args);
    const tool: TimelineTool = {
      id: toolCallId,
      name: toolName,
      args,
      ...(skill ? { skillName: skill.name } : {}),
      startedAt: Date.now(),
      started: false,
      finished: false,
    };
    this.tools.push(tool);
    return tool;
  }

  completeTool(toolCallId: string, isError: boolean, result: unknown): TimelineTool | undefined {
    const tool = this.tools.find((candidate) => candidate.id === toolCallId);
    if (!tool) return undefined;
    tool.result = { isError, result };
    tool.finishedAt = Date.now();
    return tool;
  }

  get active(): TimelineTool | undefined {
    return this.activeToolId ? this.tools.find((tool) => tool.id === this.activeToolId) : undefined;
  }

  startNextTool(): TimelineTool | undefined {
    if (this.activeToolId) return undefined;
    const tool = this.tools.find((candidate) => !candidate.started);
    if (!tool) return undefined;
    tool.started = true;
    this.activeToolId = tool.id;
    return tool;
  }

  finishActiveTool(): TimelineTool | undefined {
    const tool = this.active;
    if (!tool) return undefined;
    tool.finished = true;
    if (!tool.finishedAt) tool.finishedAt = Date.now();
    this.activeToolId = undefined;
    return tool;
  }

  hasPendingTools(): boolean {
    return Boolean(this.activeToolId) || this.tools.some((tool) => !tool.finished);
  }

  get currentText(): string {
    return this.text;
  }

  get error(): boolean {
    return this.hadError;
  }

  snapshot(): RunSnapshot {
    const finished = this.tools.filter((tool) => tool.finished).slice(-MAX_SNAPSHOT_FINISHED_TOOLS);
    const active = this.active;
    const tools = [...finished, ...(active ? [active] : [])]
      .filter((tool, index, list) => list.findIndex((candidate) => candidate.id === tool.id) === index)
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-MAX_SNAPSHOT_TOOLS);
    return { thinking: this.thinking, text: this.text, tools };
  }

  diagnostics(): Record<string, unknown> {
    return {
      activeTool: this.activeToolId ?? null,
      toolCount: this.tools.length,
      pendingToolCount: this.tools.filter((tool) => !tool.finished).length,
      tools: this.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        started: tool.started,
        finished: tool.finished,
        hasResult: Boolean(tool.result),
        isError: tool.result?.isError ?? null,
      })),
      currentTextLen: this.text.length,
      currentThinkingLen: this.thinking.length,
      hadError: this.hadError,
    };
  }
}
