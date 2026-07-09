import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect, type CSSProperties } from 'react';
import { getSkills } from './chat';
import type { AttachedContext, HarnessModelOption, ReasoningEffort, SkillSummaryView } from './types';
import {
  HARNESS_MODEL_GROUPS,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
} from './types';

interface Props {
  text: string;
  attached: AttachedContext | null;
  onTextChange: (text: string) => void;
  onAttachedChange: (attached: AttachedContext | null) => void;
  onSend: (text: string, attached: AttachedContext | null) => void;
  onStop: () => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  selectedModel: HarnessModelOption;
  onSelectedModelChange: (model: HarnessModelOption) => void;
  isStreaming: boolean;
  disabled: boolean;
  focusRecoveryEnabled: boolean;
}

const SLASH_PATTERN = /^\/([a-z0-9-]*)/i;
const MAX_SUGGESTIONS = 8;

export function InputBar({
  text,
  attached,
  onTextChange,
  onAttachedChange,
  onSend,
  onStop,
  reasoningEffort,
  onReasoningEffortChange,
  selectedModel,
  onSelectedModelChange,
  isStreaming,
  disabled,
  focusRecoveryEnabled,
}: Props) {
  const isAttached = attached !== null;
  const [skills, setSkills] = useState<SkillSummaryView[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [chipWidth, setChipWidth] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);

  // Skills fetch races the sidecar port assignment in App.tsx — if our
  // mount fires before the port is set, getSkills() throws (silently),
  // skills stays empty, and the suggestions popover never renders. So
  // we also listen for the `verso:sidecar-port` event the native shell
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
    window.addEventListener('verso:sidecar-port-ready', onPortReady);
    return () => {
      cancelled = true;
      window.removeEventListener('verso:sidecar-port-ready', onPortReady);
    };
  }, []);

  // Suggestions only fire when no skill is attached and the body starts
  // with a slash — once a skill is attached the leading slash lives in
  // chip state, not text.
  const slashMatch = useMemo(() => {
    if (isAttached) return null;
    const match = text.match(SLASH_PATTERN);
    if (!match) return null;
    return { full: match[0], query: match[1].toLowerCase() };
  }, [text, isAttached]);

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

  useEffect(() => {
    if (!focusRecoveryEnabled) return;

    const recoverFocus = () => {
      window.setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;

        const active = document.activeElement;
        const activeIsOtherEditable = active instanceof HTMLElement
          && active !== document.body
          && active !== el
          && (
            active instanceof HTMLInputElement
            || active instanceof HTMLTextAreaElement
            || active.isContentEditable
          );
        if (activeIsOtherEditable) return;

        el.focus({ preventScroll: true });
      }, 0);
    };

    window.addEventListener('verso:system-wake', recoverFocus);
    window.addEventListener('verso:restore-chat-focus', recoverFocus);
    return () => {
      window.removeEventListener('verso:system-wake', recoverFocus);
      window.removeEventListener('verso:restore-chat-focus', recoverFocus);
    };
  }, [focusRecoveryEnabled]);

  const showSuggestions = slashMatch !== null && suggestions.length > 0 && !isStreaming;

  // Measure the chip so we can text-indent the textarea's first line by
  // exactly that much — the chip then sits inline with the body text on
  // line 1, and wrapped lines start flush left, matching how the post-
  // send chip renders in the chat bubble.
  useLayoutEffect(() => {
    if (!isAttached) {
      if (chipWidth !== 0) setChipWidth(0);
      return;
    }
    const el = chipRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    setChipWidth(w + 6);
  }, [isAttached, chipWidth]);

  const attachSkill = useCallback((slug: string) => {
    onAttachedChange({ kind: 'skill', slug });
    const match = text.match(SLASH_PATTERN);
    onTextChange(match ? text.slice(match[0].length).trimStart() : text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [onAttachedChange, onTextChange, text]);

  const detachContext = useCallback(() => {
    onAttachedChange(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, 0);
    });
  }, [onAttachedChange]);

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
    if (isAttached || skills.length === 0) return;
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
  }, [text, isAttached, skills, attachSkill]);

  const handleSubmit = useCallback(() => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (disabled) return;
    const trimmedBody = text.trim();
    let payload = trimmedBody;
    if (attached?.kind === 'skill') {
      // Skills travel via slash text — orchestrator parses it back out.
      payload = trimmedBody.length > 0 ? `/${attached.slug} ${trimmedBody}` : `/${attached.slug}`;
    }
    if (!payload && attached?.kind !== 'cron') return;
    onSend(payload, attached);
    onTextChange('');
    onAttachedChange(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, attached, isStreaming, disabled, onSend, onStop, onTextChange, onAttachedChange]);

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
        onTextChange('');
        return;
      }
    }
    // Backspace at the start of an empty selection with a chip attached
    // pops the chip off — same intuition as how chips work in mail/Slack.
    if (
      e.key === 'Backspace'
      && isAttached
      && textareaRef.current
      && textareaRef.current.selectionStart === 0
      && textareaRef.current.selectionEnd === 0
    ) {
      e.preventDefault();
      detachContext();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const canSend = isStreaming || text.trim().length > 0 || isAttached;
  const placeholder = disabled
    ? 'Connecting... you can type while things load.'
    : attached?.kind === 'skill'
      ? `Message with /${attached.slug}…`
      : attached?.kind === 'cron'
        ? `Edit routine "${attached.name}" — describe the change`
        : 'Write a message...';

  return (
    <div style={{ padding: '10px 12px', background: 'var(--bg)' }}>
      <div
        onMouseDown={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest('button')) return;
          window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        }}
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
        {attached && (
          <span
            ref={chipRef}
            className={`input-skill-chip${attached.kind === 'cron' ? ' is-cron' : ''}`}
            style={{
              position: 'absolute',
              top: '12px',
              left: '16px',
              pointerEvents: 'auto',
            }}
            aria-label={attached.kind === 'skill'
              ? `Skill attached: /${attached.slug}`
              : `Routine attached: ${attached.name}`}
          >
            {attached.kind === 'skill' ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M5 1 L6 4 L9 5 L6 6 L5 9 L4 6 L1 5 L4 4 Z" fill="currentColor" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="5.5" cy="5.5" r="4.4" />
                <polyline points="5.5,3 5.5,5.5 7.5,6.6" />
              </svg>
            )}
            <span className="input-skill-chip-slug">
              {attached.kind === 'skill' ? `/${attached.slug}` : attached.name}
            </span>
            <button
              type="button"
              className="input-skill-chip-remove"
              onMouseDown={(event) => {
                event.preventDefault();
                detachContext();
              }}
              aria-label={attached.kind === 'skill' ? 'Remove attached skill' : 'Remove attached routine'}
              title={attached.kind === 'skill' ? 'Remove attached skill' : 'Remove attached routine'}
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
            textIndent: isAttached ? `${chipWidth}px` : 0,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            <HarnessModelSelector
              value={selectedModel}
              onChange={onSelectedModelChange}
              disabled={disabled}
            />
            <ReasoningEffortCycler
              value={reasoningEffort}
              onChange={onReasoningEffortChange}
              disabled={disabled}
            />
          </div>
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

// Signal-bars glyph whose filled-bar count tracks the effort level
// (low → 1, medium → 2, high → 3), mirroring the Cursor/Claude footer affordance.
function EffortBars({ level }: { level: number }) {
  const heights = [4, 7, 10];
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden="true">
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 4.5}
          y={11 - h}
          width="3"
          height={h}
          rx="1"
          fill="currentColor"
          opacity={i < level ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

// Spark glyph for the model selector.
function SparkGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1 L7 5 L11 6 L7 7 L6 11 L5 7 L1 6 L5 5 Z" fill="currentColor" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,6.5 4.7,9 10,3" />
    </svg>
  );
}

function StarGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M6 1.2 7.4 4.3 10.8 4.7 8.3 7 9 10.4 6 8.7 3 10.4 3.7 7 1.2 4.7 4.6 4.3 6 1.2Z" />
    </svg>
  );
}

function HelpGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="4.2" />
      <path d="M4.8 4.7a1.35 1.35 0 0 1 2.45.8c0 .9-1.25 1.05-1.25 1.85" />
      <path d="M6 8.8h.01" />
    </svg>
  );
}

function ExternalArrowGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7 7 3" />
      <path d="M4.4 3H7v2.6" />
    </svg>
  );
}

function ChevronRightGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}

function ProviderLogo({ harnessType }: { harnessType: HarnessModelOption['harnessType'] }) {
  if (harnessType === 'codex') {
    return (
      <svg className="harness-model-logo-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2.9c2.1 0 3.3 1.1 4.1 2.6 1.7-.1 3.2.6 4.1 2.2 1 1.8.6 3.5-.4 4.8.9 1.4 1 3.1 0 4.8-1.1 1.8-2.7 2.4-4.3 2.2-.8 1.5-2 2.6-4.1 2.6s-3.3-1.1-4.1-2.6c-1.7.1-3.2-.6-4.1-2.2-1-1.8-.6-3.5.4-4.8-.9-1.4-1-3.1 0-4.8C4.2 6.1 5.8 5.5 7.5 5.6 8.3 4 9.7 2.9 12 2.9Z" />
        <path d="M7.5 5.6 12 8.2l4.1-2.7" />
        <path d="M3.6 12.5 8 10v-4" />
        <path d="M7.3 19.5V14l-3.7-1.5" />
        <path d="M15.5 19.5 12 16l-4.7 3.5" />
        <path d="M19.8 12.5 16 14v5.5" />
        <path d="M16.1 5.5V10l3.7 2.5" />
        <path d="M8 10l4 2.3 4-2.3" />
        <path d="M12 12.3V16" />
      </svg>
    );
  }

  if (harnessType === 'amp') {
    return (
      <svg className="harness-model-logo-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 18 9.4 5.8c.2-.5.9-.5 1.1 0L15.4 18" />
        <path d="M7 13h6" />
        <path d="M16 6v12" />
        <path d="M19.5 8.5v7" />
      </svg>
    );
  }

  return (
    <svg className="harness-model-logo-svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 1.8 13.25 8.25 18 3.7 15.25 9.65 21.7 8.4 16.2 12 21.7 15.6 15.25 14.35 18 20.3 13.25 15.75 12 22.2 10.75 15.75 6 20.3 8.75 14.35 2.3 15.6 7.8 12 2.3 8.4 8.75 9.65 6 3.7 10.75 8.25 12 1.8Z" />
    </svg>
  );
}

// Shared styling for the footer controls.
function footerCycleStyle(disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-dim)',
    borderRadius: '7px',
    padding: '3px 6px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit',
    opacity: disabled ? 0.4 : 1,
  };
}

function cycleNext<T>(items: readonly T[], current: T): T {
  const index = items.indexOf(current);
  return items[(index + 1) % items.length];
}

function ReasoningEffortCycler({
  value,
  onChange,
  disabled,
}: {
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(cycleNext(REASONING_EFFORTS, value))}
      disabled={disabled}
      aria-label={`Reasoning effort: ${REASONING_EFFORT_LABELS[value]} (click to change)`}
      title="Reasoning effort"
      style={footerCycleStyle(disabled)}
    >
      <EffortBars level={REASONING_EFFORTS.indexOf(value) + 1} />
      <span>{REASONING_EFFORT_LABELS[value]}</span>
    </button>
  );
}

function HarnessModelSelector({
  value,
  onChange,
  disabled,
}: {
  value: HarnessModelOption;
  onChange: (model: HarnessModelOption) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const match = HARNESS_MODEL_GROUPS
        .flatMap((group) => group.options)
        .find((option) => option.shortcut === event.key);
      if (!match) return;
      event.preventDefault();
      onChange(match);
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onChange, open]);

  return (
    <div ref={rootRef} className="harness-selector-root">
      {open && (
        <div className="harness-model-popover" role="listbox" aria-label="Agent model">
          {HARNESS_MODEL_GROUPS.map((group) => (
            <div className="harness-model-group" key={group.id}>
              <div className="harness-model-group-label">
                <span className="harness-model-logo">
                  <ProviderLogo harnessType={group.id} />
                </span>
                <span>{group.label}</span>
                <span className="harness-model-help" title={`${group.label} harness`}>
                  <HelpGlyph />
                </span>
              </div>
              {group.options.map((option) => {
                const selected = option.id === value.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`harness-model-row${selected ? ' is-selected' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onChange(option);
                      setOpen(false);
                    }}
                  >
                    <span className="harness-model-logo">
                      <ProviderLogo harnessType={option.harnessType} />
                    </span>
                    <span className="harness-model-title">
                      <span className="harness-model-name">{option.label}</span>
                      {option.harnessType === 'claudecode' && (
                        <span className="harness-model-external">
                          <ExternalArrowGlyph />
                        </span>
                      )}
                    </span>
                    <span className="harness-model-badge-slot">
                      {option.badge && <span className="harness-model-badge">{option.badge}</span>}
                    </span>
                    <span className="harness-model-check">{selected ? <CheckGlyph /> : null}</span>
                    <span className="harness-model-star" title={option.favorite ? 'Favorite' : undefined}>
                      {option.favorite ? <StarGlyph /> : null}
                    </span>
                    <span className="harness-model-shortcut">{option.shortcut ?? ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="harness-model-footer">
            <span>Harnesses</span>
            <ChevronRightGlyph />
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((next) => !next)}
        disabled={disabled}
        aria-label={`Model: ${value.label}`}
        aria-expanded={open}
        title="Model"
        style={footerCycleStyle(disabled)}
      >
        <SparkGlyph />
        <span>{value.label}</span>
      </button>
    </div>
  );
}
