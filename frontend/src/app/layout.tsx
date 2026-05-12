import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppPrivyProvider } from '../components/privy-provider';

export const metadata: Metadata = {
  title: 'Verso — a personal second brain',
  description:
    'Verso is the easiest way to run local Hermes agents that connect to the apps you already use.',
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
