import { IngestionStore, type IngestionSourceState } from './ingestion-store.ts';
import { SlackSource } from './slack-source.ts';
import { SourceIngestionScheduler } from './source-ingestion.ts';

const DMS_ENABLED_KEY = 'slack.dmsEnabled';
const DM_STREAMS_KEY = 'slack.dmStreams';
const DEFAULT_DM_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export interface SlackChannelView {
  id: string;
  name: string;
  isPrivate: boolean;
  isExternal: boolean;
  enabled: boolean;
}

/**
 * Owns Slack's per-channel + all-DMs selection. Channels are individual enabled
 * streams in the ingestion store; "DMs" is a dynamic category — a flag plus a
 * periodic sync that lists im/mpim conversations and ensures a stream per DM,
 * picking up new ones over time. DMs default OFF.
 */
export class SlackSelectionService {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly slack: SlackSource,
    private readonly store: IngestionStore,
    private readonly scheduler: SourceIngestionScheduler,
    private readonly dmSyncIntervalMs = DEFAULT_DM_SYNC_INTERVAL_MS,
  ) {}

  async listChannels(): Promise<SlackChannelView[]> {
    const conversations = await this.slack.listConversations('public_channel,private_channel');
    return conversations
      .filter((c) => !c.isIm && !c.isMpim)
      .map((c) => ({
        id: c.id,
        name: c.name,
        isPrivate: c.isPrivate,
        isExternal: c.isExternal,
        enabled: Boolean(this.store.getSource('slack', c.id)?.enabled),
      }));
  }

  setChannelEnabled(channelId: string, enabled: boolean): IngestionSourceState | null {
    return this.scheduler.setStreamEnabled('slack', channelId, enabled);
  }

  getDmsEnabled(): boolean {
    return this.store.getConfig(DMS_ENABLED_KEY) === 'true';
  }

  async setDmsEnabled(enabled: boolean): Promise<void> {
    this.store.setConfig(DMS_ENABLED_KEY, enabled ? 'true' : 'false');
    try {
      if (enabled) {
        await this.syncDms();
      } else {
        this.disableAllDms();
      }
    } catch (error) {
      // The action failed — don't leave the flag flipped, or the UI would show
      // DMs on and the periodic sync would later start ingesting them.
      this.store.setConfig(DMS_ENABLED_KEY, enabled ? 'false' : 'true');
      throw error;
    }
  }

  /** When DMs are on, ensure every current im/mpim has an enabled stream (adds new ones over time). */
  async syncDms(): Promise<void> {
    if (!this.getDmsEnabled()) return;
    const dms = await this.slack.listConversations('im,mpim');
    const tracked = this.dmStreamIds();
    for (const dm of dms) {
      if (!tracked.has(dm.id)) {
        this.scheduler.setStreamEnabled('slack', dm.id, true);
        tracked.add(dm.id);
      }
    }
    this.store.setConfig(DM_STREAMS_KEY, JSON.stringify([...tracked]));
  }

  /** Turn Slack ingestion fully off: disable every enabled channel/DM stream and the DM category. */
  disableAll(): void {
    for (const stream of this.store.listSourceStreams('slack')) {
      if (stream.enabled) this.scheduler.setStreamEnabled('slack', stream.stream, false);
    }
    this.store.setConfig(DMS_ENABLED_KEY, 'false');
    this.store.setConfig(DM_STREAMS_KEY, '[]');
  }

  /** Periodic DM refresh so newly-created DMs start getting ingested. */
  start(): void {
    if (this.interval) return;
    void this.syncDms().catch(() => undefined);
    this.interval = setInterval(() => { void this.syncDms().catch(() => undefined); }, this.dmSyncIntervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  private disableAllDms(): void {
    for (const id of this.dmStreamIds()) {
      this.scheduler.setStreamEnabled('slack', id, false);
    }
    this.store.setConfig(DM_STREAMS_KEY, '[]');
  }

  private dmStreamIds(): Set<string> {
    try {
      const parsed = JSON.parse(this.store.getConfig(DM_STREAMS_KEY) ?? '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  }
}
