'use client';

import type { ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { frontendRuntimeConfig } from '../lib/runtime-config';

export function AppPrivyProvider({ children }: { children: ReactNode }) {
  if (!frontendRuntimeConfig.privyAppId) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider appId={frontendRuntimeConfig.privyAppId}>
      {children}
    </PrivyProvider>
  );
}
