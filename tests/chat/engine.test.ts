/**
 * The engine's structural guarantees — the ones that are code, not prompt.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/db/client';
import { buildDateHint, findUngroundedTimes, handleInbound } from '../../src/chat/engine';
import { detectEscalation } from '../../src/chat/escalation';
import { ScriptedChatModel } from '../../src/providers/chat-model/scripted';
import { ConsoleNotifier } from '../../src/providers/notifier/console';
import { setProviders, resetProviders } from '../../src/providers/registry';
import { loadSession } from '../../src/chat/session';
import { resetDb, seedFixture } from '../helpers/db';

const NOW = new Date('2026-09-09T07:00:00Z'); // Rabu 9 Sept, 14:00 WIB

beforeEach(async () => {
  await resetDb();
  await seedFixture();
  setProviders({ notifier: new ConsoleNotifier() });
});

afterAll(async () => {
  resetProviders();
  await closeDb();
});

describe('buildDateHint', () => {
  it('resolves the date for the model instead of letting it calculate', () => {
    const hint = buildDateHint('besok sore bisa?', NOW)!;
    expect(hint).toContain('2026-09-10');
    expect(hint).toContain('sore');
    expect(hint).toContain('Hari ini 2026-09-09');
  });

  it('says plainly when no date was mentioned, rather than inventing one', () => {
    expect(buildDateHint('berapaan sih potong', NOW)).toContain('tidak menyebut tanggal');
  });
});

describe('findUngroundedTimes', () => {
  it('accepts a time that came from a tool result', () => {
    expect(findUngroundedTimes('Bisa jam 15:00 kak', new Set(['15:00']))).toEqual([]);
  });

  it('flags a time the model invented', () => {
    expect(findUngroundedTimes('Bisa jam 19:45 kak', new Set(['15:00']))).toEqual(['19:45']);
  });

  it('accepts a dotted Indonesian time when the tool returned the colon form', () => {
    expect(findUngroundedTimes('jam 15.00 ya', new Set(['15:00']))).toEqual([]);
  });
});

describe('the anti-hallucination guard', () => {
  it('throws loudly when the model states a time no tool returned', async () => {
    // The model answers with a confident time having called no tool at all.
    setProviders({
      chatModel: new ScriptedChatModel([{ text: 'Bisa kak, besok jam 16:30 ya!' }]),
      notifier: new ConsoleNotifier(),
    });

    await expect(
      handleInbound({ fromPhone: '628111000401', body: 'besok bisa?', receivedAt: NOW }),
    ).rejects.toThrow(/BUG, bukan masalah prompt/);
  });

  it('permits the same sentence once a tool has supplied that time', async () => {
    setProviders({
      chatModel: new ScriptedChatModel([
        {
          toolCalls: [
            {
              name: 'checkAvailability',
              arguments: {
                staffName: 'Maria',
                serviceName: 'Potong Rambut Pria',
                dateOrRange: '2026-09-10',
              },
            },
          ],
        },
        { afterTool: 'checkAvailability', text: 'Bisa kak, besok jam 16:30 ya!' },
      ]),
      notifier: new ConsoleNotifier(),
    });

    const result = await handleInbound({
      fromPhone: '628111000402',
      body: 'besok bisa?',
      receivedAt: NOW,
    });
    expect(result.reply).toContain('16:30');
  });
});

describe('escalation', () => {
  it('classifies complaints and price negotiation, but not a price question', () => {
    expect(detectEscalation('saya kecewa banget')).toBe('complaint');
    expect(detectEscalation('bisa kurang gak harganya')).toBe('price_negotiation');
    expect(detectEscalation('minta refund dong')).toBe('complaint');
    // A question about price is the bot's job to answer from a tool result.
    expect(detectEscalation('berapaan sih potong sama clara')).toBeNull();
    expect(detectEscalation('besok sore bisa?')).toBeNull();
  });

  it('hands off after two tool errors', async () => {
    const phone = '628111000403';
    // Both calls name a service that does not exist, so both tools fail.
    setProviders({
      chatModel: new ScriptedChatModel([
        {
          toolCalls: [
            {
              name: 'checkAvailability',
              arguments: { serviceName: 'Sulap', dateOrRange: '2026-09-10' },
            },
            {
              name: 'checkAvailability',
              arguments: { serviceName: 'Sulap', dateOrRange: '2026-09-11' },
            },
          ],
        },
      ]),
      notifier: new ConsoleNotifier(),
    });

    const result = await handleInbound({ fromPhone: phone, body: 'besok bisa?', receivedAt: NOW });
    expect(result.handedOff).toBe(true);
    expect(result.handoffReason).toBe('repeated_tool_errors');
  });

  it('hands off after three turns that resolve nothing', async () => {
    const phone = '628111000404';
    // The model chats without ever calling a tool: no progress is being made.
    setProviders({
      chatModel: new ScriptedChatModel([{ text: 'Hmm gimana ya kak.' }]),
      notifier: new ConsoleNotifier(),
    });

    const send = () => handleInbound({ fromPhone: phone, body: 'gimana dong', receivedAt: NOW });

    expect((await send()).handedOff).toBe(false);
    expect((await send()).handedOff).toBe(false);
    const third = await send();

    expect(third.handedOff).toBe(true);
    expect(third.handoffReason).toBe('unresolved_turns');
  });

  it('stops replying entirely once a thread is handed off', async () => {
    const phone = '628111000405';
    setProviders({
      chatModel: new ScriptedChatModel([{ text: 'halo' }]),
      notifier: new ConsoleNotifier(),
    });

    await handleInbound({ fromPhone: phone, body: 'saya komplain nih', receivedAt: NOW });
    const after = await handleInbound({ fromPhone: phone, body: 'halo min?', receivedAt: NOW });

    expect(after.reply).toBeNull();
    expect(after.handedOff).toBe(true);

    const session = await loadSession(phone);
    expect(session.handedOff).toBe(true);
    expect(session.handoffReason).toBe('complaint');
  });

  it('records the handoff so the owner sees the flagged thread', async () => {
    const phone = '628111000406';
    setProviders({ chatModel: new ScriptedChatModel([]), notifier: new ConsoleNotifier() });
    await handleInbound({ fromPhone: phone, body: 'nego dong harganya', receivedAt: NOW });

    const session = await loadSession(phone);
    expect(session.handedOff).toBe(true);
    expect(session.handoffReason).toBe('price_negotiation');
  });
});

describe('tool boundary', () => {
  it('reports an unknown staff name as an error rather than inventing one', async () => {
    setProviders({
      chatModel: new ScriptedChatModel([
        {
          toolCalls: [
            {
              name: 'checkAvailability',
              arguments: {
                staffName: 'Budi',
                serviceName: 'Potong Rambut Pria',
                dateOrRange: '2026-09-10',
              },
            },
          ],
        },
        { afterTool: 'checkAvailability', text: 'Maaf kak.' },
      ]),
      notifier: new ConsoleNotifier(),
    });

    const result = await handleInbound({
      fromPhone: '628111000407',
      body: 'sama budi besok bisa?',
      receivedAt: NOW,
    });
    // Budi is not in the database. The tool fails; the model cannot pretend otherwise.
    expect(result.toolCalls[0]!.ok).toBe(false);
  });
});
