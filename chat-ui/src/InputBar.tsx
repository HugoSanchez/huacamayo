import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
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
  const [skills, setSkills] = useState<SkillSummaryView[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getSkills()
      .then((next) => {
        if (!cancelled) setSkills(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const slashMatch = useMemo(() => {
    const match = text.match(SLASH_PATTERN);
    if (!match) return null;
    return { full: match[0], query: match[1].toLowerCase() };
  }, [text]);

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

  const insertSkill = useCallback((slug: string) => {
    setText((prev) => {
      const match = prev.match(SLASH_PATTERN);
      if (!match) return prev;
      return `/${slug} ${prev.slice(match[0].length).trimStart()}`;
    });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, isStreaming, disabled, onSend, onStop]);

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
        insertSkill(suggestions[highlightIndex].slug);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
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

  const canSend = isStreaming || text.trim().length > 0;

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
            onSelect={insertSkill}
            onHover={setHighlightIndex}
          />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Connecting... you can type while things load.' : 'Write a message...'}
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
