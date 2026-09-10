import type { Metadata } from 'next';
import { BUSINESS } from '@/config/business';
import './globals.css';

export const metadata: Metadata = {
  title: BUSINESS.name,
  description: `Booking online ${BUSINESS.name}`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
