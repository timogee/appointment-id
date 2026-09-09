import type { Notifier } from './types';

/** Logs instead of sending. The real one is WhatsAppCloudNotifier — see docs/PRODUCTION-PATH.md. */
export class ConsoleNotifier implements Notifier {
  readonly sent: Array<{ toPhone: string; body: string; template?: string }> = [];

  async sendText(toPhone: string, body: string): Promise<void> {
    this.sent.push({ toPhone, body });
    console.log(`\n[WA -> ${toPhone}]\n${body}\n`);
  }

  async sendTemplate(
    toPhone: string,
    templateName: string,
    params: ReadonlyArray<string>,
  ): Promise<void> {
    const body = `(template ${templateName}) ${params.join(' | ')}`;
    this.sent.push({ toPhone, body, template: templateName });
    console.log(`\n[WA template -> ${toPhone}]\n${body}\n`);
  }
}
