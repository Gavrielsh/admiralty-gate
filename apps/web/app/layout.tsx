import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import { EventsProvider } from '@/lib/events';
import './globals.css';

export const metadata: Metadata = {
  title: 'admiralty-gate console',
  description: 'Live monitor for the admiralty-gate information-flow gate',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <EventsProvider>
          <Shell>{children}</Shell>
        </EventsProvider>
      </body>
    </html>
  );
}
