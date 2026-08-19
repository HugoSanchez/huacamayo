import { describe, expect, it } from 'vitest';
import { updateInputDraftAttachment, updateInputDraftText } from './chat-input-draft-model';

describe('chat input drafts', () => {
  it('keeps text and attachments scoped to their session', () => {
    let drafts = updateInputDraftText({}, 'session-a', 'Message A');
    drafts = updateInputDraftAttachment(drafts, 'session-a', {
      kind: 'cron',
      id: 'cron-1',
      name: 'Weekly report',
    });
    drafts = updateInputDraftText(drafts, 'session-b', 'Message B');

    expect(drafts['session-a']).toEqual({
      text: 'Message A',
      attached: { kind: 'cron', id: 'cron-1', name: 'Weekly report' },
    });
    expect(drafts['session-b']).toEqual({ text: 'Message B', attached: null });
  });

  it('preserves text when an attachment is removed', () => {
    const drafts = updateInputDraftAttachment(
      { session: { text: 'Keep me', attached: null } },
      'session',
      null,
    );
    expect(drafts.session).toEqual({ text: 'Keep me', attached: null });
  });
});
