/**
 * Meta's webhook endpoint. GET is the one-time verification handshake; POST is
 * every subsequent inbound message. This is the only place that knows Meta's
 * request shape — everything past parseMessages() is the same handleInbound
 * path the CLI repl uses.
 */
import { getProviders } from '@/providers/registry';
import { handleInbound } from '@/chat/engine';
import { WhatsAppWebhookAdapter } from '@/providers/inbound/whatsapp-webhook';

function requireWhatsAppAdapter(): WhatsAppWebhookAdapter | null {
  const { inbound } = getProviders();
  return inbound instanceof WhatsAppWebhookAdapter ? inbound : null;
}

export async function GET(request: Request): Promise<Response> {
  const inbound = requireWhatsAppAdapter();
  if (!inbound) {
    return new Response('INBOUND_ADAPTER is not whatsapp_webhook', { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const challenge = inbound.verifyHandshake(searchParams);
  if (challenge === null) return new Response('Forbidden', { status: 403 });
  return new Response(challenge, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  const inbound = requireWhatsAppAdapter();
  if (!inbound) {
    return new Response('INBOUND_ADAPTER is not whatsapp_webhook', { status: 404 });
  }

  const rawBody = await request.text();
  if (!inbound.verifySignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    return new Response('Forbidden', { status: 403 });
  }

  const messages = inbound.parseMessages(JSON.parse(rawBody));

  for (const message of messages) {
    try {
      // handleInbound sends the reply itself via the notifier (see engine.ts) —
      // sending it again here would double-deliver every message.
      await handleInbound(message);
    } catch (error) {
      // Meta retries on non-200. A processing failure for one message must not
      // cause it to redeliver the whole batch, so log and keep going.
      console.error('[whatsapp webhook] failed to process message', error);
    }
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
}
