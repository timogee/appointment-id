import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { InboundAdapter, InboundHandler } from './types';

/**
 * Terminal adapter: type as a customer, no Meta setup required. The WhatsApp
 * webhook adapter is added later as one more file implementing this interface.
 */
export class CliInboundAdapter implements InboundAdapter {
  readonly name = 'cli';

  constructor(private readonly fromPhone: string) {}

  async start(handler: InboundHandler): Promise<void> {
    const rl = createInterface({ input: stdin, output: stdout });
    console.log(`\nKetik pesan sebagai ${this.fromPhone}. Ctrl+C untuk keluar.\n`);

    try {
      for (;;) {
        const body = (await rl.question('kamu > ')).trim();
        if (!body) continue;
        if (body === '/quit' || body === '/exit') break;
        await handler({ fromPhone: this.fromPhone, body, receivedAt: new Date() });
      }
    } finally {
      rl.close();
    }
  }
}
