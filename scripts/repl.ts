/**
 * Talk to the bot in a terminal. No Meta setup, no webhook, no ngrok.
 *
 * The engine cannot tell this apart from a real WhatsApp message: both arrive as
 * { fromPhone, body, receivedAt } through an InboundAdapter.
 *
 * With ANTHROPIC_API_KEY set this uses the real model. Without it the registry
 * falls back to ScriptedChatModel, which will not hold a conversation — set the
 * key for a live demo.
 */
import { loadEnv } from '../src/env';
loadEnv();

import { closeDb } from '../src/db/client';
import { getProviders } from '../src/providers/registry';
import { handleInbound } from '../src/chat/engine';
import { BUSINESS } from '../src/config/business';

const { inbound, chatModel } = getProviders();

console.log(`\n=== ${BUSINESS.name} — chat lokal ===`);
console.log(`model: ${chatModel.constructor.name}`);
if (chatModel.constructor.name === 'ScriptedChatModel') {
  console.log('(!) ANTHROPIC_API_KEY belum diisi, jadi bot tidak akan menjawab dengan nyata.');
}

await inbound.start(async (message) => {
  try {
    const result = await handleInbound(message);
    if (result.toolCalls.length > 0) {
      console.log(
        `  [tools] ${result.toolCalls.map((c) => `${c.name}${c.ok ? '' : ' (ERROR)'}`).join(', ')}`,
      );
    }
    if (result.handedOff) {
      console.log(
        `  [handoff] ${String(result.handoffReason)} — bot berhenti membalas thread ini.`,
      );
    }
    if (result.reply === null && !result.handedOff) {
      console.log('  (bot tidak membalas)');
    }
  } catch (error) {
    console.error('  [ERROR]', error instanceof Error ? error.message : error);
  }
});

await closeDb();
