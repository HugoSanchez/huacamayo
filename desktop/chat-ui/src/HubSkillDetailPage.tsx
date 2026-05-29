import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getHubSkill, installHubSkill } from './chat';
import type { HubSkillDetailView } from './types';

interface Props {
  identifier: string;
  onTitleResolved?: (name: string | null) => void;
}

export function HubSkillDetailPage({ identifier, onTitleResolved }: Props) {
  const [detail, setDetail] = useState<HubSkillDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setInstallError(null);
    setDetail(null);
    void getHubSkill(identifier)
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
  }, [identifier]);

  const handleInstall = async () => {
    if (!detail || detail.installed || isInstalling) return;

    setIsInstalling(true);
    setInstallError(null);
    try {
      await installHubSkill(detail.identifier);
      const next = await getHubSkill(identifier);
      setDetail(next);
      onTitleResolved?.(next.name);
    } catch (err: unknown) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstalling(false);
    }
  };

  const installBlocked = installError ? /blocked|unsafe|not safe|security|verdict/i.test(installError) : false;

  return (
    <div className="skill-page">
      <div className="skill-page-inner">
        {isLoading && !detail && <div className="catalog-overlay-empty">Loading skill...</div>}
        {error && <div className="catalog-overlay-error">{error}</div>}
        {detail && (
          <>
            <div className="skill-detail-header">
              <div className="skill-detail-header-main">
                <div className="skill-detail-title-row">
                  <div className="skill-detail-title">{detail.name}</div>
                </div>
                {detail.description && (
                  <div className="skill-detail-subtitle">{detail.description}</div>
                )}
              </div>
            </div>

            <div className="skill-detail-meta">
              <span className={`skill-detail-tag is-${detail.trustLevel}`}>{detail.trustLevel || 'unknown'}</span>
              <span className="skill-detail-tag">{detail.source || 'hub'}</span>
              {detail.installed && <span className="skill-detail-tag">installed</span>}
              {detail.tags.map((tag) => (
                <span key={tag} className="skill-detail-tag">{tag}</span>
              ))}
            </div>

            <div className="skill-detail-hint">
              {detail.identifier}
            </div>

            <div className="skill-detail-actions">
              <button
                type="button"
                className={`skill-detail-action${detail.installed ? ' is-ghost' : ' is-primary'}${isInstalling ? ' is-loading' : ''}`}
                onClick={handleInstall}
                disabled={detail.installed || isInstalling}
              >
                {detail.installed ? (
                  <>
                    <svg
                      width="14" height="14" viewBox="0 0 16 16"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="3,8.5 6.5,12 13,4.5" />
                    </svg>
                    Installed
                  </>
                ) : isInstalling ? (
                  <>
                    <span className="skill-install-spinner" aria-hidden="true" />
                    Installing
                  </>
                ) : (
                  'Install'
                )}
              </button>
            </div>

            {installError && (
              <div className={`skill-install-warning${installBlocked ? ' is-security' : ''}`} role="alert">
                {installBlocked
                  ? 'Installation stopped: we scanned this skill and found it not to be safe enough.'
                  : installError}
              </div>
            )}

            <div className="skill-detail-content message-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.content}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
