/**
 * The LLM boundary. The model may only speak in terms of tool calls defined in
 * src/chat/tools.ts. It never computes a time, a price, or an availability answer.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Hand-written; see src/chat/tools.ts. */
  inputSchema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatCompletion {
  /** Prose to send the customer. May be empty when the model only called tools. */
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatModel {
  complete(
    messages: ReadonlyArray<ChatMessage>,
    tools: ReadonlyArray<ToolSpec>,
    system: string,
  ): Promise<ChatCompletion>;
}
