/**
 * THE provider registry. Implementations are selected here and nowhere else.
 *
 * Swapping a fake for a real implementation must cost exactly two things:
 *   1. a new file implementing the interface,
 *   2. one branch in this file.
 * If it ever costs more, the abstraction is wrong — fix the abstraction, do not
 * work around it at the call site.
 *
 * Env keys are documented in .env.example.
 */
import type { Notifier } from './notifier/types';
import type { PaymentProvider } from './payment/types';
import type { ChatModel } from './chat-model/types';
import type { InboundAdapter } from './inbound/types';
import { ConsoleNotifier } from './notifier/console';
import { ManualTransferProvider } from './payment/manual-transfer';
import { AnthropicChatModel } from './chat-model/anthropic';
import { ScriptedChatModel } from './chat-model/scripted';
import { CliInboundAdapter } from './inbound/cli';

export interface Providers {
  notifier: Notifier;
  payments: PaymentProvider;
  chatModel: ChatModel;
  inbound: InboundAdapter;
}

let overrides: Partial<Providers> = {};
let cached: Providers | null = null;

function buildNotifier(): Notifier {
  switch (process.env.NOTIFIER ?? 'console') {
    case 'console':
      return new ConsoleNotifier();
    // case 'whatsapp_cloud': return new WhatsAppCloudNotifier(...)  <- one new file
    default:
      throw new Error(`Unknown NOTIFIER: ${process.env.NOTIFIER}`);
  }
}

function buildPayments(): PaymentProvider {
  switch (process.env.PAYMENT_PROVIDER ?? 'manual') {
    case 'manual':
      return new ManualTransferProvider();
    // case 'midtrans': return new MidtransProvider(...)  <- one new file, CLIENT's entity
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${process.env.PAYMENT_PROVIDER}`);
  }
}

function buildChatModel(): ChatModel {
  const choice = process.env.CHAT_MODEL ?? 'auto';
  const key = process.env.ANTHROPIC_API_KEY;

  // 'auto' keeps a fresh clone runnable and the test suite offline: without a key
  // there is nothing to call, so fall back rather than crash.
  if (choice === 'anthropic' || (choice === 'auto' && key)) {
    if (!key) throw new Error('CHAT_MODEL=anthropic but ANTHROPIC_API_KEY is not set.');
    return new AnthropicChatModel(key);
  }
  return new ScriptedChatModel([]);
}

function buildInbound(): InboundAdapter {
  switch (process.env.INBOUND_ADAPTER ?? 'cli') {
    case 'cli':
      return new CliInboundAdapter(process.env.CLI_PHONE ?? '628123456789');
    // case 'whatsapp_webhook': return new WhatsAppWebhookAdapter(...)  <- one new file
    default:
      throw new Error(`Unknown INBOUND_ADAPTER: ${process.env.INBOUND_ADAPTER}`);
  }
}

export function getProviders(): Providers {
  if (!cached) {
    cached = {
      notifier: overrides.notifier ?? buildNotifier(),
      payments: overrides.payments ?? buildPayments(),
      chatModel: overrides.chatModel ?? buildChatModel(),
      inbound: overrides.inbound ?? buildInbound(),
    };
  }
  return cached;
}

/** Tests inject fakes here. Production code never calls this. */
export function setProviders(next: Partial<Providers>): void {
  overrides = { ...overrides, ...next };
  cached = null;
}

export function resetProviders(): void {
  overrides = {};
  cached = null;
}
