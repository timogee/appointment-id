/**
 * When the bot must stop and fetch a human. These are deterministic checks in
 * application code, NOT prompt instructions, because a customer who is upset can
 * talk a prompt out of its rules but cannot talk a regex out of matching.
 */
export type EscalationReason =
  'complaint' | 'price_negotiation' | 'unresolved_turns' | 'repeated_tool_errors';

/** Turns without a successful booking-related tool call before we hand off. */
export const MAX_UNRESOLVED_TURNS = 3;

/** Tool failures in one conversation before we hand off. */
export const MAX_TOOL_ERRORS = 2;

const COMPLAINT_PATTERNS = [
  /\bkecewa\b/i,
  /\bkomplain\b/i,
  /\bkomplen\b/i,
  /\bmarah\b/i,
  /\bparah\b/i,
  /\bjelek\b/i,
  /\bgak\s*(puas|becus|profesional)\b/i,
  /\bnggak\s*(puas|becus)\b/i,
  /\brusak\b/i,
  /\bgagal\s*potong\b/i,
  /\bminta\s*(refund|uang\s*kembali|ganti\s*rugi)\b/i,
  /\blapor\b/i,
  /\bnuntut\b/i,
];

const PRICE_NEGOTIATION_PATTERNS = [
  /\bnego\b/i,
  /\bkurang(in|i)?\s*(dong|ya|gak|nggak)?\b.*\b(harga|nya)\b/i,
  /\bdiskon\b/i,
  /\bpotongan\s*harga\b/i,
  /\bmurah(in|an)\b/i,
  /\bbisa\s*kurang\b/i,
  /\bboleh\s*kurang\b/i,
  /\bgak\s*bisa\s*murah\b/i,
  /\bharga\s*(nya\s*)?(mahal|kemahalan)\b/i,
  /\bmahal\s*(banget|amat)\b/i,
];

/**
 * Detect a message that must go to a human immediately.
 * Returns null when the bot may continue.
 *
 * Deliberately NOT matched: a plain price QUESTION ("berapaan sih potong sama
 * clara"). Answering that from a tool result is the bot's job. Only an attempt
 * to CHANGE the price escalates.
 */
export function detectEscalation(message: string): EscalationReason | null {
  if (COMPLAINT_PATTERNS.some((p) => p.test(message))) return 'complaint';
  if (PRICE_NEGOTIATION_PATTERNS.some((p) => p.test(message))) return 'price_negotiation';
  return null;
}

export function escalationMessage(reason: EscalationReason): string {
  switch (reason) {
    case 'complaint':
      return 'Maaf banget ya kak. Ini aku sambungkan ke ownernya langsung, ditunggu sebentar.';
    case 'price_negotiation':
      return 'Soal harga aku nggak bisa putuskan sendiri kak. Aku sambungkan ke ownernya ya.';
    case 'unresolved_turns':
      return 'Kayaknya lebih enak ngobrol langsung sama ownernya ya kak. Aku sambungkan sekarang.';
    case 'repeated_tool_errors':
      return 'Maaf kak, sistemnya lagi bermasalah. Aku sambungkan ke ownernya ya.';
  }
}
