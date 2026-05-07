import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSkills, toggleSkill } from './chat';
import type { SkillSummaryView } from './types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectSkill: (slug: string) => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export function SkillsCatalogOverlay({ isOpen, onClose, onSelectSkill }: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [skills, setSkills] = useState<SkillSummaryView[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);

  const fetchTokenRef = useRef(0);

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

      <div className="catalog-overlay-search">
        <input
          type="text"
          className="catalog-overlay-search-input"
          placeholder="Search skills"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      {error && <div className="catalog-overlay-error">{error}</div>}

      <div className="catalog-overlay-list">
        {isLoading && filteredSkills.length === 0 && (
          <div className="catalog-overlay-empty">Loading…</div>
        )}
        {!isLoading && !error && filteredSkills.length === 0 && (
          <div className="catalog-overlay-empty">
            {searchQuery ? `No skills matching “${searchQuery}”.` : 'No skills installed.'}
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

