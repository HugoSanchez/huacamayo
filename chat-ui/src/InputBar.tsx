import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { getSkills } from './chat';
import type { SkillSummaryView } from './types';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled: boolean;
}

const SLASH_PATTERN = /^\/([a-z0-9-]*)/i;
const MAX_SUGGESTIONS = 8;

export function InputBar({ onSend, onStop, isStreaming, disabled }: Props) {
  const [text, setText] = useState('');
  const [attachedSlug, setAttachedSlug] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummaryView[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [chipWidth, setChipWidth] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);

  // Skills fetch races the sidecar port assignment in App.tsx — if our
  // mount fires before the port is set, getSkills() throws (silently),
  // skills stays empty, and the suggestions popover never renders. So
  // we also listen for the `vervo:sidecar-port` event the native shell
  // dispatches and refetch on each port update.
  useEffect(() => {
    let cancelled = false;
    const fetchSkills = async () => {
      try {
        const next = await getSkills();
        if (!cancelled) setSkills(next);
      } catch {
        // sidecar not ready yet
      }
    };
    void fetchSkills();
    const onPortReady = () => { void fetchSkills(); };
    window.addEventListener('vervo:sidecar-port-ready', onPortReady);
    return () => {
      cancelled = true;
      window.removeEventListener('vervo:sidecar-port-ready', onPortReady);
    };
  }, []);

  // Suggestions only fire when no skill is attached and the body starts
  // with a slash — once a skill is attached the leading slash lives in
  // chip state, not text.
  const slashMatch = useMemo(() => {
    if (attachedSlug) return null;
    const match = text.match(SLASH_PATTERN);
    if (!match) return null;
    return { full: match[0], query: match[1].toLowerCase() };
  }, [text, attachedSlug]);

  const suggestions = useMemo(() => {
    if (!slashMatch) return [];
    const { query } = slashMatch;
    const filtered = skills.filter((skill) => {
      if (!query) return true;
      const haystack = `${skill.slug} ${skill.name} ${skill.description}`.toLowerCase();
      return haystack.includes(query);
    });
    filtered.sort((a, b) => {
      const aStarts = a.slug.startsWith(query) ? 0 : 1;
      const bStarts = b.slug.startsWith(query) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.slug.localeCompare(b.slug);
    });
    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [skills, slashMatch]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [slashMatch?.query]);

  const showSuggestions = slashMatch !== null && suggestions.length > 0 && !isStreaming;

  // Measure the chip so we can text-indent the textarea's first line by
  // exactly that much — the chip then sits inline with the body text on
  // line 1, and wrapped lines start flush left, matching how the post-
  // send chip renders in the chat bubble.
  useLayoutEffect(() => {
    if (!attachedSlug) {
      if (chipWidth !== 0) setChipWidth(0);
      return;
    }
    const el = chipRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    setChipWidth(w + 6);
  }, [attachedSlug, chipWidth]);

  const attachSkill = useCallback((slug: string) => {
    setAttachedSlug(slug);
    setText((prev) => {
      const match = prev.match(SLASH_PATTERN);
      return match ? prev.slice(match[0].length).trimStart() : prev;
    });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const detachSkill = useCallback(() => {
    setAttachedSlug(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, 0);
    });
  }, []);

  // Auto-promote `/slug` to a chip as soon as the typed slug uniquely
  // identifies a real skill — no need to pick from the popover or hit
  // space first. This makes the input mirror the post-send chip while
  // the user is typing.
  //
  // We only promote when the typed slug has no longer sibling (e.g.
  // typing "/apple" doesn't promote because "apple-notes" and
  // "apple-reminders" exist; typing "/apple-notes" does). Backspace at
  // the start of an empty body still pops the chip off.
  useEffect(() => {
    if (attachedSlug || skills.length === 0) return;
    const match = text.match(/^\/([a-z0-9-]+)(\s|$)/i);
    if (!match) return;
    const slug = match[1].toLowerCase();
    const isExact = skills.some((s) => s.slug === slug);
    if (!isExact) return;
    const hasLongerSibling = skills.some(
      (s) => s.slug !== slug && s.slug.startsWith(`${slug}-`),
    );
    if (hasLongerSibling) return;
    attachSkill(slug);
  }, [text, attachedSlug, skills, attachSkill]);

  const handleSubmit = useCallback(() => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (disabled) return;
    const trimmedBody = text.trim();
    const payload = attachedSlug
      ? trimmedBody.length > 0
        ? `/${attachedSlug} ${trimmedBody}`
        : `/${attachedSlug}`
      : trimmedBody;
    if (!payload) return;
    onSend(payload);
    setText('');
    setAttachedSlug(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, attachedSlug, isStreaming, disabled, onSend, onStop]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        attachSkill(suggestions[highlightIndex].slug);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    // Backspace at the start of an empty selection with a chip attached
    // pops the chip off — same intuition as how chips work in mail/Slack.
    if (
      e.key === 'Backspace'
      && attachedSlug
      && textareaRef.current
      && textareaRef.current.selectionStart === 0
      && textareaRef.current.selectionEnd === 0
    ) {
      e.preventDefault();
      detachSkill();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const canSend = isStreaming || text.trim().length > 0 || attachedSlug !== null;
  const placeholder = disabled
    ? 'Connecting... you can type while things load.'
    : attachedSlug
      ? `Message with /${attachedSlug}…`
      : 'Write a message...';

  return (
    <div style={{ padding: '10px 12px', background: 'var(--bg)' }}>
      <div
        style={{
          position: 'relative',
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          borderRadius: '16px',
          padding: '12px 16px',
          minHeight: '100px',
        }}
      >
        {showSuggestions && (
          <SlashSuggestions
            items={suggestions}
            highlightIndex={highlightIndex}
            onSelect={attachSkill}
            onHover={setHighlightIndex}
          />
        )}
        {attachedSlug && (
          <span
            ref={chipRef}
            className="input-skill-chip"
            style={{
              position: 'absolute',
              top: '12px',
              left: '16px',
              pointerEvents: 'auto',
            }}
            aria-label={`Skill attached: /${attachedSlug}`}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1 L6 4 L9 5 L6 6 L5 9 L4 6 L1 5 L4 4 Z" fill="currentColor" />
            </svg>
            <span className="input-skill-chip-slug">/{attachedSlug}</span>
            <button
              type="button"
              className="input-skill-chip-remove"
              onMouseDown={(event) => {
                event.preventDefault();
                detachSkill();
              }}
              aria-label="Remove attached skill"
              title="Remove attached skill"
            >
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
                <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
              </svg>
            </button>
          </span>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontSize: '14px',
            lineHeight: '1.5',
            resize: 'none',
            fontFamily: 'inherit',
            maxHeight: '160px',
            minHeight: '48px',
            textIndent: attachedSlug ? `${chipWidth}px` : 0,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: '4px' }}>
          <button
            onClick={handleSubmit}
            disabled={disabled || !canSend}
            style={{
              border: '1px solid var(--border)',
              background: canSend && !disabled ? 'var(--text)' : 'transparent',
              color: canSend && !disabled ? 'var(--bg)' : 'var(--text-dim)',
              borderRadius: '8px',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.3 : 1,
              padding: 0,
              fontSize: '16px',
              lineHeight: 1,
            }}
            aria-label={isStreaming ? 'Stop' : 'Send'}
          >
            {isStreaming ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <rect x="2" y="2" width="10" height="10" rx="1.5" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="12" x2="8" y2="4" />
                <polyline points="4,7 8,3 12,7" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SlashSuggestions({
  items,
  highlightIndex,
  onSelect,
  onHover,
}: {
  items: SkillSummaryView[];
  highlightIndex: number;
  onSelect: (slug: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="slash-popover" role="listbox">
      <div className="slash-popover-header">SKILLS</div>
      {items.map((item, index) => (
        <button
          key={item.slug}
          type="button"
          role="option"
          aria-selected={index === highlightIndex}
          className={`slash-popover-row${index === highlightIndex ? ' is-highlighted' : ''}`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item.slug);
          }}
        >
          <span className="slash-popover-slug">/{item.slug}</span>
          {item.description && (
            <span className="slash-popover-description">{item.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}
