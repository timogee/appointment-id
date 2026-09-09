import { cookies } from 'next/headers';

/**
 * Single admin password from env. Deliberately minimal — but booking_audit
 * already stores actor_id, so replacing this with real auth is additive.
 * See docs/PRODUCTION-PATH.md step 1.
 */
const COOKIE = 'admin_session';

export async function isAdmin(): Promise<boolean> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;
  const store = await cookies();
  return store.get(COOKIE)?.value === password;
}

export async function signIn(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || password !== expected) return false;
  const store = await cookies();
  store.set(COOKIE, expected, { httpOnly: true, sameSite: 'lax', path: '/' });
  return true;
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}
