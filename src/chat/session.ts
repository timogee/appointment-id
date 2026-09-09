import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chatSession } from '@/db/schema';
import type { ChatMessage } from '@/providers/chat-model/types';

export interface SessionState {
  phone: string;
  handedOff: boolean;
  handoffReason: string | null;
  unresolvedTurns: number;
  toolErrors: number;
  transcript: ChatMessage[];
}

export async function loadSession(phone: string): Promise<SessionState> {
  const [row] = await db.select().from(chatSession).where(eq(chatSession.phone, phone)).limit(1);
  if (!row) {
    return {
      phone,
      handedOff: false,
      handoffReason: null,
      unresolvedTurns: 0,
      toolErrors: 0,
      transcript: [],
    };
  }
  return {
    phone: row.phone,
    handedOff: row.handedOff,
    handoffReason: row.handoffReason,
    unresolvedTurns: row.unresolvedTurns,
    toolErrors: row.toolErrors,
    transcript: (row.transcript as ChatMessage[]) ?? [],
  };
}

export async function saveSession(state: SessionState): Promise<void> {
  const values = {
    phone: state.phone,
    handedOff: state.handedOff,
    handoffReason: state.handoffReason,
    unresolvedTurns: state.unresolvedTurns,
    toolErrors: state.toolErrors,
    // Keep the tail only: a WhatsApp thread can run for months.
    transcript: state.transcript.slice(-40),
    updatedAt: new Date(),
  };
  await db.insert(chatSession).values(values).onConflictDoUpdate({
    target: chatSession.phone,
    set: values,
  });
}

export async function listHandoffs() {
  return db.select().from(chatSession).where(eq(chatSession.handedOff, true));
}

export async function clearHandoff(phone: string): Promise<void> {
  await db
    .update(chatSession)
    .set({ handedOff: false, handoffReason: null, unresolvedTurns: 0, toolErrors: 0 })
    .where(eq(chatSession.phone, phone));
}
