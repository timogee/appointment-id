/**
 * The webhook adapter is the only thing standing between an untrusted internet
 * POST and handleInbound. These tests pin the two security-critical bits
 * (handshake token check, signature check) and the payload parsing.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WhatsAppWebhookAdapter } from '../../src/providers/inbound/whatsapp-webhook';

const VERIFY_TOKEN = 'a-verify-token';
const APP_SECRET = 'an-app-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

describe('verifyHandshake', () => {
  const adapter = new WhatsAppWebhookAdapter(VERIFY_TOKEN, APP_SECRET);

  it('echoes the challenge when mode and token match', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '12345',
    });
    expect(adapter.verifyHandshake(params)).toBe('12345');
  });

  it('rejects a wrong token', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '12345',
    });
    expect(adapter.verifyHandshake(params)).toBeNull();
  });

  it('rejects a missing or wrong mode', () => {
    const params = new URLSearchParams({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '12345',
    });
    expect(adapter.verifyHandshake(params)).toBeNull();
  });
});

describe('verifySignature', () => {
  const adapter = new WhatsAppWebhookAdapter(VERIFY_TOKEN, APP_SECRET);
  const body = '{"entry":[]}';

  it('accepts a correctly signed body', () => {
    expect(adapter.verifySignature(body, sign(body))).toBe(true);
  });

  it('rejects a body signed with the wrong secret', () => {
    const wrongSignature = `sha256=${createHmac('sha256', 'not-the-secret').update(body).digest('hex')}`;
    expect(adapter.verifySignature(body, wrongSignature)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const signature = sign(body);
    expect(adapter.verifySignature('{"entry":[{}]}', signature)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(adapter.verifySignature(body, null)).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(adapter.verifySignature(body, 'not-a-real-header')).toBe(false);
  });
});

describe('parseMessages', () => {
  const adapter = new WhatsAppWebhookAdapter(VERIFY_TOKEN, APP_SECRET);

  it('extracts a text message', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '6281234567890',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'halo' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = adapter.parseMessages(payload);
    expect(messages).toEqual([
      { fromPhone: '6281234567890', body: 'halo', receivedAt: new Date(1700000000 * 1000) },
    ]);
  });

  it('ignores non-text messages and status callbacks', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '6281234567890', timestamp: '1700000000', type: 'image' }],
              },
            },
          ],
        },
      ],
    };
    expect(adapter.parseMessages(payload)).toEqual([]);
  });

  it('handles a payload with no messages at all', () => {
    expect(adapter.parseMessages({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
  });
});
