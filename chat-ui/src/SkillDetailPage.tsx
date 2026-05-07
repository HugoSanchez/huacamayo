import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSkill, toggleSkill } from './chat';
import type { SkillDetailView } from './types';

interface Props {
  slug: string;
  onOpenInNewSession: (slug: string) => void;
}

export function SkillDetailPage({ slug, onOpenInNewSession }: Props) {
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
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
                <div className="skill-detail-title">{detail.name}</div>
                {detail.description && (
                  <div className="skill-detail-subtitle">{detail.description}</div>
                )}
              </div>
              <span
                className={`skill-row-toggle is-${detail.enabled ? 'on' : 'off'}${isToggling ? ' is-loading' : ''}`}
                role="switch"
                aria-checked={detail.enabled}
                onClick={handleToggle}
              >
                <span className="skill-row-toggle-thumb" />
              </span>
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
                className="skill-detail-action is-secondary"
                onClick={handleCopy}
              >
                {isCopied ? 'Copied' : `Copy /${detail.slug}`}
              </button>
              <button
                type="button"
                className="skill-detail-action is-primary"
                onClick={() => onOpenInNewSession(detail.slug)}
              >
                Open in new session
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
