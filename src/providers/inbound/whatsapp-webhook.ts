import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundAdapter, InboundHandler, InboundMessage } from './types';

interface WhatsAppTextMessage {
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppTextMessage[];
      };
    }>;
  }>;
}

/**
 * Meta delivers messages by HTTP POST, not by a pull loop, so there is nothing
 * for `start` to loop over the way CliInboundAdapter loops over stdin. The real
 * delivery point is src/app/api/whatsapp/route.ts, which calls verifyHandshake,
 * verifySignature and parseMessages on this class directly, then hands the
 * result to handleInbound itself. This class exists so Meta's payload shape and
 * signature scheme live in one place, not in the route.
 */
export class WhatsAppWebhookAdapter implements InboundAdapter {
  readonly name = 'whatsapp_webhook';

  constructor(
    private readonly verifyToken: string,
    private readonly appSecret: string,
  ) {}

  /** Nothing to start: the HTTP route is the delivery mechanism, not this loop. */
  async start(_handler: InboundHandler): Promise<void> {
    return new Promise(() => {});
  }

  /** Meta's one-time GET handshake. Returns the challenge to echo, or null to reject. */
  verifyHandshake(params: URLSearchParams): string | null {
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');
    if (mode !== 'subscribe' || !challenge || !token) return null;
    return timingSafeEqualStrings(token, this.verifyToken) ? challenge : null;
  }

  /**
   * Every POST body must carry this header, an HMAC-SHA256 over the RAW
   * (unparsed) body using the app secret. Must run before the body is parsed
   * as JSON — a re-serialized body will not match the signature.
   */
  verifySignature(rawBody: string, header: string | null): boolean {
    if (!header) return false;
    const [scheme, signature] = header.split('=');
    if (scheme !== 'sha256' || !signature) return false;
    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    return timingSafeEqualStrings(signature, expected);
  }

  /** Text messages only; status callbacks and other message types are ignored. */
  parseMessages(payload: unknown): InboundMessage[] {
    const body = payload as WhatsAppWebhookPayload;
    const out: InboundMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (message.type !== 'text' || !message.text) continue;
          out.push({
            fromPhone: message.from,
            body: message.text.body,
            receivedAt: new Date(Number(message.timestamp) * 1000),
          });
        }
      }
    }
    return out;
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
