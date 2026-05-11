import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSkill, pinSkill, toggleSkill } from './chat';
import type { SkillDetailView } from './types';

interface Props {
  slug: string;
  onOpenInNewSession: (slug: string) => void;
  onTitleResolved?: (name: string | null) => void;
}

export function SkillDetailPage({ slug, onOpenInNewSession, onTitleResolved }: Props) {
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isPinning, setIsPinning] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setDetail(null);
    void getSkill(slug)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        onTitleResolved?.(next.name);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleToggle = async () => {
    if (!detail || isToggling) return;
    setIsToggling(true);
    try {
      const updated = await toggleSkill(detail.slug, !detail.enabled);
      setDetail((prev) => (prev ? { ...prev, enabled: updated.enabled } : prev));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsToggling(false);
    }
  };

  const handlePin = async () => {
    if (!detail || isPinning) return;
    setIsPinning(true);
    try {
      const updated = await pinSkill(detail.slug, !detail.pinned);
      setDetail((prev) => (prev ? { ...prev, pinned: updated.pinned } : prev));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPinning(false);
    }
  };

  const handleCopy = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(`/${detail.slug}`);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="skill-page">
      <div className="skill-page-inner">
        {isLoading && !detail && <div className="catalog-overlay-empty">Loading skill…</div>}
        {error && <div className="catalog-overlay-error">{error}</div>}
        {detail && (
          <>
            <div className="skill-detail-header">
              <div>
                <div className="skill-detail-title-row">
                  <div className="skill-detail-title">{detail.name}</div>
                  <button
                    type="button"
                    className={`skill-detail-copy${isCopied ? ' is-copied' : ''}`}
                    onClick={handleCopy}
                    aria-label={isCopied ? 'Copied' : `Copy /${detail.slug}`}
                    title={isCopied ? 'Copied' : `Copy /${detail.slug}`}
                  >
                    <svg
                      className="skill-detail-copy-icon skill-detail-copy-icon-default"
                      width="14" height="14" viewBox="0 0 16 16"
                      fill="none" stroke="currentColor" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="5" y="5" width="9" height="9" rx="1.5" />
                      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-5A1.5 1.5 0 0 0 3 3.5v5A1.5 1.5 0 0 0 4.5 10H6" />
                    </svg>
                    <svg
                      className="skill-detail-copy-icon skill-detail-copy-icon-check"
                      width="14" height="14" viewBox="0 0 16 16"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="3,8.5 6.5,12 13,4.5" />
                    </svg>
                  </button>
                </div>
                {detail.description && (
                  <div className="skill-detail-subtitle">{detail.description}</div>
                )}
              </div>
              <div className="skill-detail-header-controls">
                <button
                  type="button"
                  className={`skill-detail-pin${detail.pinned ? ' is-pinned' : ''}${isPinning ? ' is-loading' : ''}`}
                  onClick={handlePin}
                  aria-pressed={detail.pinned}
                  aria-label={detail.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                  title={detail.pinned ? 'Pinned to sidebar' : 'Pin to sidebar'}
                  disabled={isPinning}
                >
                  <svg
                    width="16" height="16" viewBox="0 0 16 16"
                    fill={detail.pinned ? 'currentColor' : 'none'}
                    stroke="currentColor" strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M8 2 L9.7 6.1 L14 6.5 L10.7 9.3 L11.7 13.5 L8 11.2 L4.3 13.5 L5.3 9.3 L2 6.5 L6.3 6.1 Z" />
                  </svg>
                </button>
                <span
                  className={`skill-row-toggle is-${detail.enabled ? 'on' : 'off'}${isToggling ? ' is-loading' : ''}`}
                  role="switch"
                  aria-checked={detail.enabled}
                  onClick={handleToggle}
                >
                  <span className="skill-row-toggle-thumb" />
                </span>
              </div>
            </div>

            {(detail.tags.length > 0 || detail.prerequisites.length > 0) && (
              <div className="skill-detail-meta">
                {detail.tags.map((tag) => (
                  <span key={tag} className="skill-detail-tag">{tag}</span>
                ))}
                {detail.prerequisites.map((prereq) => (
                  <span key={prereq} className="skill-detail-prereq">requires {prereq}</span>
                ))}
              </div>
            )}

            <div className="skill-detail-actions">
              <button
                type="button"
                className="skill-detail-action is-primary"
                onClick={() => onOpenInNewSession(detail.slug)}
              >
                <svg
                  width="14" height="14" viewBox="0 0 16 16"
                  fill="none" stroke="currentColor" strokeWidth="1.6"
                  strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 3h4v4" />
                  <path d="M13 3 7.5 8.5" />
                  <path d="M13 9.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V5a1.5 1.5 0 0 1 1.5-1.5H7" />
                </svg>
                <span>Open in new session</span>
              </button>
            </div>

            <div className="skill-detail-hint">
              Type <code>/{detail.slug}</code> in any chat to load this skill into that session.
            </div>

            <div className="skill-detail-content message-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.content}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
