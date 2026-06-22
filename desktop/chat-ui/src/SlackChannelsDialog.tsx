import { useEffect, useMemo, useState } from 'react';
import { getSlackChannels, toggleSlackChannel, toggleSlackDms, type SlackChannelView } from './chat';

interface Props {
  isOpen: boolean;
  logoUrl?: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

const DMS_KEY = '__dms__';

export function SlackChannelsDialog({ isOpen, logoUrl, onClose, onChanged }: Props) {
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

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const { regular, external } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = (channels ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
    return {
      regular: matched.filter((c) => !c.isExternal),
      external: matched.filter((c) => c.isExternal),
    };
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

  const busy = pending !== null;
  const hasChannels = channels !== null;
  const noMatches = hasChannels && regular.length === 0 && external.length === 0;

  return (
    <div className="ingestion-modal-backdrop" onClick={onClose}>
      <div
        className="ingestion-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Slack channels"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ingestion-modal-head">
          <button className="ingestion-modal-close" type="button" onClick={onClose} aria-label="Close">
            <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {logoUrl ? <img className="ingestion-modal-logo" src={logoUrl} alt="" aria-hidden="true" /> : null}
          <div className="ingestion-modal-title">Select the channels you want to ingest</div>
        </header>

        <div className="ingestion-modal-search">
          <input
            type="text"
            className="ingestion-modal-search-input"
            placeholder="Search channels"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>

        {error && <div className="ingestion-modal-error">{error}</div>}

        <div className="ingestion-modal-list">
          <div className="ingestion-modal-section">Direct messages</div>
          <div
            className="ingestion-modal-row"
            role="switch"
            aria-checked={dmsEnabled}
            aria-disabled={busy}
            onClick={handleDms}
          >
            <span className="ingestion-modal-row-label is-stacked">
              <span className="ingestion-modal-row-text">All direct messages</span>
              <span className="ingestion-modal-row-sub">Includes group DMs · private · off by default</span>
            </span>
            <Toggle on={dmsEnabled} />
          </div>

          {!hasChannels && !error && <div className="ingestion-modal-empty">Loading…</div>}

          {regular.length > 0 && <div className="ingestion-modal-section">Channels</div>}
          {regular.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} busy={busy} onToggle={handleChannel} />
          ))}

          {external.length > 0 && <div className="ingestion-modal-section">External connections</div>}
          {external.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} busy={busy} onToggle={handleChannel} />
          ))}

          {noMatches && (
            <div className="ingestion-modal-empty">
              {search ? `No channels matching “${search.trim()}”.` : 'No channels.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelRow({ channel, busy, onToggle }: { channel: SlackChannelView; busy: boolean; onToggle: (c: SlackChannelView) => void }) {
  return (
    <div
      className="ingestion-modal-row"
      role="switch"
      aria-checked={channel.enabled}
      aria-disabled={busy}
      onClick={() => onToggle(channel)}
    >
      <span className="ingestion-modal-row-label">
        {channel.isPrivate ? <LockGlyph /> : <span className="ingestion-modal-hash">#</span>}
        <span className="ingestion-modal-row-text">{channel.name}</span>
      </span>
      <Toggle on={channel.enabled} />
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`skill-row-toggle is-${on ? 'on' : 'off'}`} aria-hidden="true">
      <span className="skill-row-toggle-thumb" />
    </span>
  );
}

function LockGlyph() {
  return (
    <svg className="ingestion-modal-lock" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
