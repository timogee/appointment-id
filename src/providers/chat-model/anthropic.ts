import Anthropic from '@anthropic-ai/sdk';
import type { ChatCompletion, ChatMessage, ChatModel, ToolSpec } from './types';

/**
 * The real model. Note what is NOT here: no date maths, no price lookup, no
 * availability reasoning. Those live in application code and reach the model
 * only as tool results.
 */
export class AnthropicChatModel implements ChatModel {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(
    messages: ReadonlyArray<ChatMessage>,
    tools: ReadonlyArray<ToolSpec>,
    system: string,
  ): Promise<ChatCompletion> {
    const response = await this.client.messages.create({
      model: this.model,
      // WhatsApp replies are two or three sentences. This cap is deliberate,
      // not a guess — the tool results carry the substance, not the prose.
      max_tokens: 1024,
      // Relaying a tool result needs no deep reasoning, and low effort keeps
      // replies fast and cheap. Raise it only if routing quality drops.
      output_config: { effort: 'low' },
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: toAnthropicMessages(messages),
    });

    let text = '';
    const toolCalls: ChatCompletion['toolCalls'] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return { text: text.trim(), toolCalls };
  }
}

/** Our neutral message shape -> Anthropic's content blocks. */
function toAnthropicMessages(messages: ReadonlyArray<ChatMessage>): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
    } else {
      // Tool results are user-role blocks in the Anthropic API. Consecutive ones
      // must be merged into a single user message.
      const block: Anthropic.ContentBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}
