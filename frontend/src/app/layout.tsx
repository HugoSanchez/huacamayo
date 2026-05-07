import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppPrivyProvider } from '../components/privy-provider';

export const metadata: Metadata = {
  title: 'Vervo Frontend',
  description: 'Privy auth and onboarding surface for Vervo.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppPrivyProvider>{children}</AppPrivyProvider>
      </body>
    </html>
  );
}
