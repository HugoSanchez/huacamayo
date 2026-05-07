import { PrivyClient } from '@privy-io/node';
import type { BackendConfig } from '../config.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from './types.ts';

export class BackendPrivyVerifier implements PrivyAuthVerifier {
  private readonly client: PrivyClient;

  constructor(config: BackendConfig) {
    if (!config.privyConfigured) {
      throw new Error('Privy is not configured.');
    }

    this.client = new PrivyClient({
      appId: config.PRIVY_APP_ID!,
      appSecret: config.PRIVY_APP_SECRET!,
    });
  }

  async verifyAuthToken(accessToken: string): Promise<VerifiedPrivyAuthToken> {
    const claims = await this.client.utils().auth().verifyAccessToken(accessToken);
    return {
      userId: claims.user_id,
      sessionId: claims.session_id,
      appId: claims.app_id,
      issuer: claims.issuer,
      issuedAt: claims.issued_at,
      expiration: claims.expiration,
    };
  }
}
