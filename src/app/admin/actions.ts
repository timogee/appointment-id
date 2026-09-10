'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelBooking,
  confirmDpReceived,
  markCompleted,
  markNoShow,
} from '@/domain/booking-service';
import { clearHandoff } from '@/chat/session';
import { isAdmin, signIn, signOut } from './auth';

/** Every action re-checks auth. The owner is the actor on every audit row it writes. */
async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error('Tidak punya akses.');
}

const OWNER = { kind: 'owner' as const };

export async function loginAction(formData: FormData): Promise<void> {
  await signIn(String(formData.get('password') ?? ''));
  revalidatePath('/admin');
}

export async function logoutAction(): Promise<void> {
  await signOut();
  revalidatePath('/admin');
}

export async function confirmDpAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const proof = String(formData.get('proofImageUrl') ?? '').trim();
  await confirmDpReceived(String(formData.get('bookingId')), OWNER, proof || undefined);
  revalidatePath('/admin');
}

export async function completeAction(formData: FormData): Promise<void> {
  await requireAdmin();
  await markCompleted(String(formData.get('bookingId')), OWNER);
  revalidatePath('/admin');
}

export async function noShowAction(formData: FormData): Promise<void> {
  await requireAdmin();
  await markNoShow(String(formData.get('bookingId')), OWNER);
  revalidatePath('/admin');
}

export async function cancelAction(formData: FormData): Promise<void> {
  await requireAdmin();
  await cancelBooking(String(formData.get('bookingId')), OWNER);
  revalidatePath('/admin');
}

export async function resolveHandoffAction(formData: FormData): Promise<void> {
  await requireAdmin();
  await clearHandoff(String(formData.get('phone')));
  revalidatePath('/admin');
}
