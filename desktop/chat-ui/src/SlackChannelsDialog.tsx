import { useEffect, useMemo, useState } from 'react';
import { getSlackChannels, toggleSlackChannel, toggleSlackDms, type SlackChannelView } from './chat';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

const DMS_KEY = '__dms__';

export function SlackChannelsDialog({ isOpen, onClose, onChanged }: Props) {
  const [channels, setChannels] = useState<SlackChannelView[] | null>(null);
  const [dmsEnabled, setDmsEnabled] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setChannels(null);
    setError(null);
    setSearch('');
    void getSlackChannels()
      .then((result) => { if (!cancelled) { setChannels(result.channels); setDmsEnabled(result.dmsEnabled); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (channels ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [channels, search]);

  async function handleChannel(channel: SlackChannelView) {
    if (pending) return;
    setPending(channel.id);
    try {
      await toggleSlackChannel(channel.id, !channel.enabled);
      setChannels((prev) => (prev ? prev.map((c) => (c.id === channel.id ? { ...c, enabled: !channel.enabled } : c)) : prev));
      setError(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function handleDms() {
    if (pending) return;
    setPending(DMS_KEY);
    try {
      const result = await toggleSlackDms(!dmsEnabled);
      setDmsEnabled(result.dmsEnabled);
      setError(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  if (!isOpen) return null;

  return (
    <aside className="catalog-overlay" role="dialog" aria-label="Slack channels">
      <header className="catalog-overlay-head">
        <div className="catalog-overlay-title">Slack — what to remember</div>
        <button className="catalog-overlay-close" type="button" onClick={onClose} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="catalog-overlay-search">
        <input
          type="text"
          className="catalog-overlay-search-input"
          placeholder="Search channels"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      {error && <div className="catalog-overlay-error">{error}</div>}

      <div className="catalog-overlay-list">
        <div className="catalog-row" key={DMS_KEY}>
          <div className="catalog-row-name">
            Direct messages
            <div className="settings-footnote">All DMs &amp; group DMs — private. Off by default.</div>
          </div>
          <span
            className={`skill-row-toggle is-${dmsEnabled ? 'on' : 'off'}`}
            role="switch"
            aria-checked={dmsEnabled}
            aria-disabled={pending !== null}
            onClick={handleDms}
          >
            <span className="skill-row-toggle-thumb" />
          </span>
        </div>

        {channels === null && !error && <div className="catalog-overlay-empty">Loading…</div>}
        {channels !== null && filtered.length === 0 && <div className="catalog-overlay-empty">No channels.</div>}
        {filtered.map((channel) => (
          <div className="catalog-row" key={channel.id}>
            <div className="catalog-row-name">{channel.isPrivate ? '🔒 ' : '# '}{channel.name}</div>
            <span
              className={`skill-row-toggle is-${channel.enabled ? 'on' : 'off'}`}
              role="switch"
              aria-checked={channel.enabled}
              aria-disabled={pending !== null}
              onClick={() => handleChannel(channel)}
            >
              <span className="skill-row-toggle-thumb" />
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
