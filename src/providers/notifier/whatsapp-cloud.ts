import type { Notifier } from './types';

const GRAPH_API_VERSION = 'v21.0';

/**
 * Real WhatsApp sending via the Cloud API. Credentials are read by the caller
 * (registry.ts) and passed in, so a missing token fails at startup, not on the
 * first message.
 */
export class WhatsAppCloudNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
  ) {}

  async sendText(toPhone: string, body: string): Promise<void> {
    await this.send({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body },
    });
  }

  async sendTemplate(
    toPhone: string,
    templateName: string,
    params: ReadonlyArray<string>,
  ): Promise<void> {
    await this.send({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'id' },
        components:
          params.length > 0
            ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
            : undefined,
      },
    });
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`WhatsApp Cloud API ${response.status}: ${detail}`);
    }
  }
}
