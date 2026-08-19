import { describe, expect, it } from 'vitest';
import { isCodexAuthError } from './use-chat-response-stream';

describe('chat response stream errors', () => {
  it.each([
    'No Codex credentials found',
    'Run hermes auth login',
    'Hermes model is unavailable',
  ])('recognizes provider authentication errors: %s', (message) => {
    expect(isCodexAuthError(message)).toBe(true);
  });

  it('does not treat an ordinary stream failure as an authentication error', () => {
    expect(isCodexAuthError('Connection reset by peer')).toBe(false);
  });
});
