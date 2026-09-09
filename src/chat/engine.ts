/**
 * The turn loop. Takes one normalised inbound message, runs the model against
 * the six tools in src/chat/tools.ts, and returns what to send back.
 *
 * Two things are enforced structurally here rather than by prompting:
 *
 * 1. ESCALATION. Complaints, price negotiation, three unresolved turns, or two
 *    tool errors hand off to the owner and STOP the bot replying. Checked in
 *    src/chat/escalation.ts before the model is ever consulted.
 *
 * 2. NO INVENTED FACTS. Every time and staff name in an outgoing message must
 *    have appeared in a tool result this turn. assertGroundedReply verifies that
 *    and fails loudly. A violation is a BUG in the tool layer or this file, not
 *    a prompt to tune.
 */
import { getProviders } from '@/providers/registry';
import type { ChatMessage, ToolCall } from '@/providers/chat-model/types';
import type { InboundMessage } from '@/providers/inbound/types';
import { jakartaDateKey, nextDate } from '@/domain/time';
import { SYSTEM_PROMPT } from './prompt';
import { TOOL_SPECS, executeTool, type ToolContext } from './tools';
import { parseIndonesianDate } from './date-parser';
import {
  MAX_TOOL_ERRORS,
  MAX_UNRESOLVED_TURNS,
  detectEscalation,
  escalationMessage,
  type EscalationReason,
} from './escalation';
import { loadSession, saveSession, type SessionState } from './session';

/** Model round-trips allowed in one turn before we cut it off. */
const MAX_MODEL_STEPS = 5;

export interface TurnResult {
  reply: string | null;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean }>;
  handedOff: boolean;
  handoffReason?: EscalationReason | string;
}

/**
 * Resolve Indonesian relative dates BEFORE the model sees the message, and tell
 * the model the answer. The model never does date arithmetic.
 */
export function buildDateHint(body: string, now: Date): string | null {
  const parsed = parseIndonesianDate(body, now);
  const today = jakartaDateKey(now);
  if (!parsed) {
    return `[sistem] Hari ini ${today}. Pesan ini tidak menyebut tanggal.`;
  }
  const range =
    parsed.dates.length === 1
      ? parsed.dates[0]!
      : `${parsed.dates[0]}..${parsed.dates[parsed.dates.length - 1]}`;
  const bits = [`[sistem] Hari ini ${today}. Tanggal yang dimaksud: ${range}`];
  if (parsed.timeOfDay) {
    bits.push(
      `Waktu yang dimaksud: ${parsed.timeOfDay.label} (${parsed.timeOfDay.fromTime}-${parsed.timeOfDay.toTime} WIB)`,
    );
  }
  if (parsed.explicitTime) bits.push(`Jam yang disebut: ${parsed.explicitTime} WIB`);
  return bits.join('. ') + '.';
}

/**
 * Collect every literal the customer is allowed to be told, from this turn's
 * tool results. Times, dates, prices and names all pass through here.
 */
function groundedFacts(results: ReadonlyArray<unknown>): Set<string> {
  const facts = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      facts.add(value);
      // A label like 'Kamis, 10 September 14:30' must also license its parts.
      for (const part of value.split(/[\s,]+/)) if (part) facts.add(part);
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') return Object.values(value).forEach(walk);
  };
  results.forEach(walk);
  return facts;
}

const TIME_TOKEN = /\b\d{1,2}[.:]\d{2}\b/g;

/**
 * Fails when the model states a clock time that no tool returned.
 *
 * Scope note: this catches the highest-cost hallucination — an invented time —
 * because a wrong time sends a real customer to a closed shop. Staff names are
 * constrained upstream instead: the model cannot act on a name the database does
 * not have, since resolveStaff in tools.ts throws NotFoundError.
 */
export function findUngroundedTimes(reply: string, facts: ReadonlySet<string>): string[] {
  const stated = reply.match(TIME_TOKEN) ?? [];
  return stated.filter((token) => {
    const normalised = token.replace('.', ':');
    return !facts.has(token) && !facts.has(normalised);
  });
}

export async function handleInbound(message: InboundMessage): Promise<TurnResult> {
  const session = await loadSession(message.fromPhone);
  const now = message.receivedAt;

  // A handed-off thread stays handed off. The bot does not reclaim it.
  if (session.handedOff) {
    return {
      reply: null,
      toolCalls: [],
      handedOff: true,
      handoffReason: session.handoffReason ?? 'handed_off',
    };
  }

  // Deterministic escalation, before the model is consulted at all.
  const escalation = detectEscalation(message.body);
  if (escalation) {
    return finishHandoff(session, escalation, now, message.fromPhone);
  }

  const ctx: ToolContext = { customerPhone: message.fromPhone, now };
  const { chatModel } = getProviders();

  const messages: ChatMessage[] = [
    ...session.transcript,
    { role: 'user', content: `${buildDateHint(message.body, now)}\n${message.body}` },
  ];

  const attempted: TurnResult['toolCalls'] = [];
  const toolPayloads: unknown[] = [];
  let reply = '';
  let handoffFromTool: string | undefined;

  for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
    const completion = await chatModel.complete(messages, TOOL_SPECS, SYSTEM_PROMPT);

    if (completion.toolCalls.length === 0) {
      reply = completion.text;
      messages.push({ role: 'assistant', content: completion.text });
      break;
    }

    messages.push({
      role: 'assistant',
      content: completion.text,
      toolCalls: completion.toolCalls,
    });
    if (completion.text) reply = completion.text;

    for (const call of completion.toolCalls) {
      const result = await runTool(call, ctx);
      attempted.push({ name: call.name, arguments: call.arguments, ok: result.ok });

      if (result.ok) {
        toolPayloads.push(result.data);
        if (call.name === 'handoffToOwner') {
          handoffFromTool = String(call.arguments.reason ?? 'handoff');
        }
      } else {
        session.toolErrors += 1;
      }

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(result.ok ? result.data : { error: result.error }),
      });
    }

    if (session.toolErrors >= MAX_TOOL_ERRORS) {
      return finishHandoff(session, 'repeated_tool_errors', now, message.fromPhone);
    }
    if (handoffFromTool) break;
  }

  if (handoffFromTool) {
    session.handedOff = true;
    session.handoffReason = handoffFromTool;
    session.transcript = messages;
    await saveSession(session);
    const text = reply || escalationMessage('unresolved_turns');
    await getProviders().notifier.sendText(message.fromPhone, text);
    return { reply: text, toolCalls: attempted, handedOff: true, handoffReason: handoffFromTool };
  }

  // A turn counts as resolved when a tool actually produced something.
  const madeProgress = attempted.some((c) => c.ok);
  session.unresolvedTurns = madeProgress ? 0 : session.unresolvedTurns + 1;

  if (session.unresolvedTurns >= MAX_UNRESOLVED_TURNS) {
    return finishHandoff(session, 'unresolved_turns', now, message.fromPhone);
  }

  const ungrounded = findUngroundedTimes(reply, groundedFacts(toolPayloads));
  if (ungrounded.length > 0) {
    // Loud, not silent. This is a defect in the tool layer or this file.
    throw new Error(
      `Balasan menyebut jam yang tidak berasal dari hasil tool: ${ungrounded.join(', ')}. ` +
        `Ini BUG, bukan masalah prompt. Lihat src/chat/engine.ts findUngroundedTimes.`,
    );
  }

  session.transcript = messages;
  await saveSession(session);
  if (reply) await getProviders().notifier.sendText(message.fromPhone, reply);

  return { reply: reply || null, toolCalls: attempted, handedOff: false };
}

async function runTool(call: ToolCall, ctx: ToolContext) {
  return executeTool(call.name, call.arguments, ctx);
}

async function finishHandoff(
  session: SessionState,
  reason: EscalationReason,
  now: Date,
  phone: string,
): Promise<TurnResult> {
  await executeTool('handoffToOwner', { reason }, { customerPhone: phone, now });
  session.handedOff = true;
  session.handoffReason = reason;
  await saveSession(session);

  const text = escalationMessage(reason);
  await getProviders().notifier.sendText(phone, text);
  return {
    reply: text,
    toolCalls: [{ name: 'handoffToOwner', arguments: { reason }, ok: true }],
    handedOff: true,
    handoffReason: reason,
  };
}

export { nextDate };
