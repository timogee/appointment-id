import type { ChatCompletion, ChatMessage, ChatModel, ToolSpec } from './types';

export interface ScriptedStep {
  /** Substring matched against the latest user message, case-insensitive. Omit to match any. */
  whenUserSays?: string;
  /** Matched against the most recent tool result name, for multi-step turns. */
  afterTool?: string;
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/**
 * Deterministic offline model. The test suite runs against this so it needs no
 * network and no API key. It is NOT a simulation of the real model's judgement —
 * it exists to pin the tool-call contract, which is the part that must not drift.
 */
export class ScriptedChatModel implements ChatModel {
  private callCount = 0;

  constructor(private readonly script: ReadonlyArray<ScriptedStep>) {}

  get calls(): number {
    return this.callCount;
  }

  async complete(
    messages: ReadonlyArray<ChatMessage>,
    _tools: ReadonlyArray<ToolSpec>,
    _system: string,
  ): Promise<ChatCompletion> {
    this.callCount += 1;

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const userText = (lastUser?.role === 'user' ? lastUser.content : '').toLowerCase();
    const toolName = lastTool?.role === 'tool' ? lastTool.name : undefined;

    const step =
      this.script.find(
        (s) =>
          (s.afterTool === undefined || s.afterTool === toolName) &&
          (s.whenUserSays === undefined || userText.includes(s.whenUserSays.toLowerCase())) &&
          // A step keyed on afterTool must not fire before that tool ran.
          (s.afterTool === undefined
            ? toolName === undefined || s.whenUserSays !== undefined
            : true),
      ) ?? this.script.find((s) => s.whenUserSays === undefined && s.afterTool === undefined);

    if (!step) {
      return { text: 'Bentar ya, aku cek dulu.', toolCalls: [] };
    }

    return {
      text: step.text ?? '',
      toolCalls: (step.toolCalls ?? []).map((c, i) => ({
        id: `scripted-${this.callCount}-${i}`,
        name: c.name,
        arguments: c.arguments,
      })),
    };
  }
}
