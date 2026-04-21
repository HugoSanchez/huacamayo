import { useState, useRef, useCallback } from 'react';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled: boolean;
}

export function InputBar({ onSend, onStop, isStreaming, disabled }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    if (isStreaming) {
      onStop();
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, isStreaming, onSend, onStop]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const canSend = isStreaming || text.trim().length > 0;

  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--bg)',
    }}>
      <div style={{
        position: 'relative',
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: '16px',
        padding: '12px 16px',
        minHeight: '100px',
      }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Waiting for sidecar...' : 'Ask about your research...'}
          disabled={disabled}
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
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          marginTop: '4px',
        }}>
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
