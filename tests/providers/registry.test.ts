/**
 * The registry is what makes this prototype upgradeable. These tests pin the
 * property that matters: selection happens HERE, from env, and calling code
 * only ever sees the interface.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getProviders, resetProviders, setProviders } from '../../src/providers/registry';
import { ConsoleNotifier } from '../../src/providers/notifier/console';
import { ManualTransferProvider } from '../../src/providers/payment/manual-transfer';
import { ScriptedChatModel } from '../../src/providers/chat-model/scripted';
import { AnthropicChatModel } from '../../src/providers/chat-model/anthropic';
import { CliInboundAdapter } from '../../src/providers/inbound/cli';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetProviders();
});

describe('defaults', () => {
  it('ships the fake implementations, all behind their interfaces', () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetProviders();
    const p = getProviders();

    expect(p.notifier).toBeInstanceOf(ConsoleNotifier);
    expect(p.payments).toBeInstanceOf(ManualTransferProvider);
    expect(p.inbound).toBeInstanceOf(CliInboundAdapter);
  });

  it('falls back to the scripted model without an API key, so a fresh clone runs offline', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CHAT_MODEL = 'auto';
    resetProviders();
    expect(getProviders().chatModel).toBeInstanceOf(ScriptedChatModel);
  });

  it('uses the real model when a key is present', () => {
    process.env.CHAT_MODEL = 'auto';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    resetProviders();
    expect(getProviders().chatModel).toBeInstanceOf(AnthropicChatModel);
  });

  it('fails loudly rather than silently degrading when a key is demanded but missing', () => {
    process.env.CHAT_MODEL = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    resetProviders();
    expect(() => getProviders()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('rejects an unknown implementation name instead of guessing', () => {
    process.env.NOTIFIER = 'carrier-pigeon';
    resetProviders();
    expect(() => getProviders()).toThrow(/Unknown NOTIFIER/);
  });
});

describe('ManualTransferProvider', () => {
  it('returns the business account details and the exact rupiah amount', async () => {
    const dp = await new ManualTransferProvider().createDpRequest(
      '11111111-2222-3333-4444-555555555555',
      50_000,
    );
    expect(dp.provider).toBe('manual_transfer');
    expect(dp.amountRupiah).toBe(50_000);
    expect(dp.instructions).toContain('BCA');
    expect(dp.instructions).toContain('Rp 50.000');
    // A stable reference the customer can quote back to the owner.
    expect(dp.reference).toMatch(/^DP-[0-9A-F]{8}$/);
  });
});

describe('test injection', () => {
  it('lets tests substitute a fake without touching any call site', () => {
    const notifier = new ConsoleNotifier();
    setProviders({ notifier });
    expect(getProviders().notifier).toBe(notifier);
  });
});
