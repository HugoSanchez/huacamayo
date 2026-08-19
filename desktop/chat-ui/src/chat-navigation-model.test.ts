import { describe, expect, it } from 'vitest';
import {
  chatNavigationTitle,
  createChatNavigationState,
  isChatSurfaceActive,
  reduceChatNavigation,
} from './chat-navigation-model';

describe('chat navigation model', () => {
  it('represents at most one catalog and one page', () => {
    let state = createChatNavigationState(true, true);
    expect(state.catalog).toBe('connections');

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-skills-catalog' },
    });
    expect(state.catalog).toBe('skills');

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-settings' },
    });
    expect(state).toMatchObject({ page: { kind: 'settings' }, catalog: null });
  });

  it('makes routine and settings navigation mutually exclusive', () => {
    let state = reduceChatNavigation(createChatNavigationState(), {
      type: 'shell-command',
      command: { kind: 'open-settings' },
    });
    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-cron', id: 'cron-1' },
    });

    expect(state.page).toEqual({ kind: 'cron', id: 'cron-1' });
    expect(chatNavigationTitle(state, 'Chat')).toBe('Routines');
  });

  it('clears stale resolved names when changing page families', () => {
    let state = reduceChatNavigation(createChatNavigationState(), {
      type: 'show-skill',
      slug: 'writer',
    });
    state = reduceChatNavigation(state, { type: 'resolve-skill-name', name: 'Writer' });
    expect(chatNavigationTitle(state, 'Chat')).toBe('Skills: Writer');

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-cron', id: 'cron-1' },
    });
    expect(state.activeSkillName).toBeNull();

    state = reduceChatNavigation(state, { type: 'show-skill', slug: 'researcher' });
    expect(chatNavigationTitle(state, 'Chat')).toBe('Skills');
  });

  it('treats chat as actively viewed only when no catalog covers it', () => {
    let state = createChatNavigationState();
    expect(isChatSurfaceActive(state)).toBe(true);

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-catalog' },
    });
    expect(isChatSurfaceActive(state)).toBe(false);

    state = reduceChatNavigation(state, { type: 'close-connections-catalog' });
    expect(isChatSurfaceActive(state)).toBe(true);
  });
});
