import { useCallback, useEffect, useRef, useState } from 'react';
import { getToolkits } from './chat';
import type { ToolkitView } from './types';

interface Props {
  isOpen: boolean;
  refreshToken: number;
  onClose: () => void;
  onConnect: (toolkit: ToolkitView) => void;
}

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 250;
const SCROLL_THRESHOLD_PX = 240;
const MIN_SEARCH_CHARS = 3;

export function CatalogOverlay({ isOpen, refreshToken, onClose, onConnect }: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [toolkits, setToolkits] = useState<ToolkitView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTokenRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Debounce search input -> search query. Composio requires queries to be
  // at least MIN_SEARCH_CHARS long; shorter inputs fall back to the default
  // popular list rather than firing a request.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const trimmed = searchInput.trim();
      setSearchQuery(trimmed.length >= MIN_SEARCH_CHARS ? trimmed : '');
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // Reset and load page 1 when open or query changes.
  useEffect(() => {
    if (!isOpen) return;
    const token = ++fetchTokenRef.current;
    setIsLoading(true);
    setError(null);
    setToolkits([]);
    setNextCursor(null);

    void getToolkits({
      query: searchQuery || undefined,
      limit: PAGE_SIZE,
    })
      .then((result) => {
        if (token !== fetchTokenRef.current) return;
        setToolkits(result.toolkits);
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (token !== fetchTokenRef.current) return;
        setError(friendlyError(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setIsLoading(false);
        if (listRef.current) listRef.current.scrollTop = 0;
      });
  }, [isOpen, refreshToken, searchQuery]);

  const fetchMore = useCallback(() => {
    if (!nextCursor || isFetchingMore || isLoading) return;
    const token = fetchTokenRef.current;
    setIsFetchingMore(true);
    void getToolkits({
      query: searchQuery || undefined,
      cursor: nextCursor,
      limit: PAGE_SIZE,
    })
      .then((result) => {
        if (token !== fetchTokenRef.current) return;
        setToolkits((prev) => {
          const seen = new Set(prev.map((item) => item.slug));
          const additions = result.toolkits.filter((item) => !seen.has(item.slug));
          return prev.concat(additions);
        });
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (token !== fetchTokenRef.current) return;
        setError(friendlyError(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setIsFetchingMore(false);
      });
  }, [nextCursor, isFetchingMore, isLoading, searchQuery]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      const distanceFromBottom = target.scrollHeight - (target.scrollTop + target.clientHeight);
      if (distanceFromBottom < SCROLL_THRESHOLD_PX) fetchMore();
    },
    [fetchMore],
  );

  if (!isOpen) return null;

  return (
    <aside className="catalog-overlay" role="dialog" aria-label="Available connections">
      <header className="catalog-overlay-head">
        <div className="catalog-overlay-title">Available</div>
        <button
          className="catalog-overlay-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M1 1 L9 9 M9 1 L1 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <div className="catalog-overlay-search">
        <input
          type="text"
          className="catalog-overlay-search-input"
          placeholder="Search toolkits"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      {error && <div className="catalog-overlay-error">{error}</div>}

      <div
        className="catalog-overlay-list"
        ref={listRef}
        onScroll={handleScroll}
      >
        {isLoading && toolkits.length === 0 && (
          <div className="catalog-overlay-empty">Loading…</div>
        )}
        {!isLoading && !error && toolkits.length === 0 && (
          <div className="catalog-overlay-empty">
            {searchQuery ? `No toolkits matching “${searchQuery}”.` : 'No toolkits available.'}
          </div>
        )}
        {toolkits.map((toolkit) => (
          <CatalogRow key={toolkit.slug} toolkit={toolkit} onConnect={onConnect} />
        ))}
        {isFetchingMore && (
          <div className="catalog-overlay-loading-more">Loading more…</div>
        )}
      </div>
    </aside>
  );
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The orchestrator forwards Composio's error envelope inline; strip JSON noise
  // so we surface a single human sentence rather than a raw payload.
  const jsonStart = raw.indexOf('{');
  if (jsonStart > -1) {
    return raw.slice(0, jsonStart).replace(/\(\d+\)/, '').replace(/[:\s]+$/, '').trim()
      || 'Failed to load toolkits.';
  }
  return raw || 'Failed to load toolkits.';
}

function CatalogRow({
  toolkit,
  onConnect,
}: {
  toolkit: ToolkitView;
  onConnect: (toolkit: ToolkitView) => void;
}) {
  return (
    <div className="catalog-row">
      {toolkit.logoUrl ? (
        <img
          className="catalog-row-logo"
          src={toolkit.logoUrl}
          alt=""
          aria-hidden="true"
        />
      ) : (
        <div className="catalog-row-logo-fallback" aria-hidden="true">
          {toolkit.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="catalog-row-name">{toolkit.name}</div>
      <button
        type="button"
        className={`catalog-row-pill is-${toolkit.connected ? 'connected' : 'pending'}`}
        disabled={toolkit.connected}
        onClick={() => {
          if (!toolkit.connected) onConnect(toolkit);
        }}
      >
        {toolkit.connected ? 'Connected' : 'Connect'}
      </button>
    </div>
  );
}
