import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getHubSkills, getSkills, toggleSkill } from './chat';
import type { HubSkillSummaryView, SkillSummaryView } from './types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectSkill: (slug: string) => void;
  onSelectHubSkill: (identifier: string) => void;
}

const SEARCH_DEBOUNCE_MS = 200;
const HUB_RESULT_LIMIT = 100;

export function SkillsCatalogOverlay({ isOpen, onClose, onSelectSkill, onSelectHubSkill }: Props) {
  const [activeTab, setActiveTab] = useState<'installed' | 'hub'>('installed');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [skills, setSkills] = useState<SkillSummaryView[]>([]);
  const [hubSkills, setHubSkills] = useState<HubSkillSummaryView[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isHubLoading, setIsHubLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);

  const fetchTokenRef = useRef(0);
  const hubFetchTokenRef = useRef(0);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearchQuery(searchInput.trim().toLowerCase());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const refreshSkills = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const next = await getSkills();
      if (token !== fetchTokenRef.current) return;
      setSkills(next);
    } catch (err: unknown) {
      if (token !== fetchTokenRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === fetchTokenRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refreshSkills();
  }, [isOpen, refreshSkills]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'hub') return;
    const token = ++hubFetchTokenRef.current;
    setIsHubLoading(true);
    setHubError(null);
    setHubSkills([]);

    void getHubSkills({
      query: searchQuery || undefined,
      limit: HUB_RESULT_LIMIT,
    })
      .then((result) => {
        if (token !== hubFetchTokenRef.current) return;
        setHubSkills(result.skills);
      })
      .catch((err: unknown) => {
        if (token !== hubFetchTokenRef.current) return;
        setHubError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (token === hubFetchTokenRef.current) setIsHubLoading(false);
      });
  }, [isOpen, activeTab, searchQuery]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery) return skills;
    return skills.filter((skill) => {
      const haystack = [skill.name, skill.slug, skill.description, skill.category ?? '', ...skill.tags].join(' ').toLowerCase();
      return haystack.includes(searchQuery);
    });
  }, [skills, searchQuery]);

  const handleToggle = useCallback(async (slug: string, enabled: boolean) => {
    setPendingToggle(slug);
    try {
      const updated = await toggleSkill(slug, enabled);
      setSkills((prev) => prev.map((skill) => (skill.slug === slug ? { ...skill, enabled: updated.enabled } : skill)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingToggle(null);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <aside className="catalog-overlay" role="dialog" aria-label="Skills catalog">
      <header className="catalog-overlay-head">
        <div className="catalog-overlay-title">Skills</div>
        <button
          className="catalog-overlay-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="catalog-overlay-tabs" role="tablist" aria-label="Skills sections">
        <button
          type="button"
          className={`catalog-overlay-tab${activeTab === 'installed' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('installed')}
          role="tab"
          aria-selected={activeTab === 'installed'}
        >
          Installed
        </button>
        <button
          type="button"
          className={`catalog-overlay-tab${activeTab === 'hub' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('hub')}
          role="tab"
          aria-selected={activeTab === 'hub'}
        >
          Hub
        </button>
      </div>

      <div className="catalog-overlay-search">
        <input
          type="text"
          className="catalog-overlay-search-input"
          placeholder={activeTab === 'hub' ? 'Search Skills Hub' : 'Search installed skills'}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      {activeTab === 'installed' && error && <div className="catalog-overlay-error">{error}</div>}
      {activeTab === 'hub' && hubError && <div className="catalog-overlay-error">{hubError}</div>}

      <div className="catalog-overlay-list">
        {activeTab === 'installed' ? (
          <>
            {isLoading && filteredSkills.length === 0 && (
              <div className="catalog-overlay-empty">Loading...</div>
            )}
            {!isLoading && !error && filteredSkills.length === 0 && (
              <div className="catalog-overlay-empty">
                {searchQuery ? `No skills matching "${searchQuery}".` : 'No skills installed.'}
              </div>
            )}
            {filteredSkills.map((skill) => (
              <SkillRow
                key={skill.slug}
                skill={skill}
                isToggling={pendingToggle === skill.slug}
                onSelect={() => onSelectSkill(skill.slug)}
                onToggle={(enabled) => handleToggle(skill.slug, enabled)}
              />
            ))}
          </>
        ) : (
          <>
            {isHubLoading && hubSkills.length === 0 && (
              <div className="catalog-overlay-empty">Loading...</div>
            )}
            {!isHubLoading && !hubError && hubSkills.length === 0 && (
              <div className="catalog-overlay-empty">
                {searchQuery ? `No hub skills matching "${searchQuery}".` : 'No hub skills found.'}
              </div>
            )}
            {hubSkills.map((skill) => (
              <HubSkillRow
                key={skill.identifier || skill.slug}
                skill={skill}
                onSelect={() => {
                  if (skill.identifier) onSelectHubSkill(skill.identifier);
                }}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function SkillRow({
  skill,
  isToggling,
  onSelect,
  onToggle,
}: {
  skill: SkillSummaryView;
  isToggling: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="catalog-row skill-row"
      onClick={onSelect}
    >
      <div className="catalog-row-logo-fallback" aria-hidden="true">
        {skill.name.charAt(0).toUpperCase()}
      </div>
      <div className="skill-row-text">
        <div className="catalog-row-name">{skill.name}</div>
        {skill.description && (
          <div className="skill-row-description">{skill.description}</div>
        )}
      </div>
      <span
        className={`skill-row-toggle is-${skill.enabled ? 'on' : 'off'}${isToggling ? ' is-loading' : ''}`}
        role="switch"
        aria-checked={skill.enabled}
        onClick={(event) => {
          event.stopPropagation();
          if (!isToggling) onToggle(!skill.enabled);
        }}
      >
        <span className="skill-row-toggle-thumb" />
      </span>
    </button>
  );
}

function HubSkillRow({ skill, onSelect }: { skill: HubSkillSummaryView; onSelect: () => void }) {
  const sourceLabel = skill.source === 'official' ? 'official' : skill.source || 'hub';
  const trustLabel = skill.trustLevel || 'unknown';
  return (
    <button
      type="button"
      className="catalog-row skill-row hub-skill-row"
      onClick={onSelect}
    >
      <div className="catalog-row-logo-fallback" aria-hidden="true">
        {skill.name.charAt(0).toUpperCase()}
      </div>
      <div className="skill-row-text">
        <div className="catalog-row-name">{skill.name}</div>
        {skill.description && (
          <div className="skill-row-description">{skill.description}</div>
        )}
        <div className="hub-skill-meta">
          <span className={`hub-skill-badge is-${trustLabel}`}>{trustLabel}</span>
          <span className="hub-skill-badge">{sourceLabel}</span>
          {skill.installed && <span className="hub-skill-badge is-installed">installed</span>}
        </div>
      </div>
    </button>
  );
}
