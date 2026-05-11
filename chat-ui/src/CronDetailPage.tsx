import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  createChatSession,
  cronAction,
  generateCronDescription,
  getCronDetail,
  getCronRunOutput,
  getCronRunTranscript,
  patchCron,
  patchCronDescription,
} from './chat';
import { humanizeSchedule } from './scheduleHumanize';
import { useToast } from './Toaster';
import type {
  CronDescriptionView,
  CronDetailView,
  CronJobView,
  CronRunSummaryView,
  CronRunTranscriptMessage,
  CronRunTranscriptView,
} from './types';

interface Props {
  id: string;
  onBack: () => void;
}

export function CronDetailPage({ id, onBack }: Props) {
  const [detail, setDetail] = useState<CronDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Field drafts for blur-to-save semantics. Keep them as plain strings even
  // when the source value is null so React doesn't complain about controlled
  // inputs flipping between defined and undefined.
  const [nameDraft, setNameDraft] = useState('');
  const [promptDraft, setPromptDraft] = useState('');

  const [isToggling, setIsToggling] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [isOpeningInChat, setIsOpeningInChat] = useState(false);

  // LLM-generated subtitle. We store it server-side (Vervo SQLite, not Hermes)
  // and lazy-generate on first view of a routine that doesn't have one yet.
  const [description, setDescription] = useState<CronDescriptionView | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const generationAttemptedRef = useRef<Set<string>>(new Set());

  // Run-history expansion: track which row is open + the cached markdown
  // and transcript for any rows the user has expanded so toggling is
  // instant after first read.
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runContent, setRunContent] = useState<Record<string, string>>({});
  const [runTranscript, setRunTranscript] = useState<Record<string, CronRunTranscriptView | null>>({});
  const [runLoading, setRunLoading] = useState<string | null>(null);
  const [runError, setRunError] = useState<Record<string, string>>({});

  // While polling for a Run-now to land we render a synthetic placeholder
  // row at the top of the History list. `pendingRun.startedAt` lets the row
  // show "running for 12s" so the user knows we're still waiting.
  const [pendingRun, setPendingRun] = useState<{ startedAt: number } | null>(null);
  const pendingPollRef = useRef<number | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setDetail(null);
    setExpandedRun(null);
    setRunContent({});
    setRunTranscript({});
    setRunError({});
    setPendingRun(null);
    setDescription(null);
    setDescriptionDraft('');
    setIsGeneratingDescription(false);
    setIsEditingDescription(false);
    if (pendingPollRef.current !== null) {
      window.clearInterval(pendingPollRef.current);
      pendingPollRef.current = null;
    }
    void getCronDetail(id)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setNameDraft(next.cron.name);
        setPromptDraft(next.cron.prompt);
        setDescription(next.description);
        setDescriptionDraft(next.description?.text ?? '');
        // Lazy-generate the first time we open a routine that has no
        // description yet. The ref guards against React StrictMode double-
        // mount + re-renders firing duplicate generation requests.
        if (!next.description && !generationAttemptedRef.current.has(id)) {
          generationAttemptedRef.current.add(id);
          setIsGeneratingDescription(true);
          void generateCronDescription(id)
            .then((generated) => {
              if (cancelled) return;
              setDescription(generated);
              setDescriptionDraft(generated?.text ?? '');
            })
            .catch(() => { /* leave empty — user can request manually */ })
            .finally(() => {
              if (!cancelled) setIsGeneratingDescription(false);
            });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    return () => {
      if (pendingPollRef.current !== null) {
        window.clearInterval(pendingPollRef.current);
        pendingPollRef.current = null;
      }
    };
  }, []);

  const applyCron = (next: CronJobView) => {
    setDetail((prev) => (prev ? { ...prev, cron: next } : prev));
  };

  const saveField = async (field: 'name' | 'prompt', value: string) => {
    if (!detail) return;
    try {
      const next = await patchCron(detail.cron.id, { [field]: value });
      applyCron(next);
      if (field === 'name') setNameDraft(next.name);
      if (field === 'prompt') setPromptDraft(next.prompt);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onNameBlur = () => {
    if (!detail) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === detail.cron.name) {
      setNameDraft(detail.cron.name);
      return;
    }
    void saveField('name', trimmed);
  };

  const onPromptBlur = () => {
    if (!detail) return;
    if (promptDraft === detail.cron.prompt) return;
    void saveField('prompt', promptDraft);
  };

  const handleToggleState = async () => {
    if (!detail || isToggling) return;
    const isPaused = detail.cron.state === 'paused';
    setIsToggling(true);
    try {
      const next = await cronAction(detail.cron.id, isPaused ? 'resume' : 'pause');
      applyCron(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsToggling(false);
    }
  };

  const handleRunNow = async () => {
    if (!detail || isRunningNow || pendingRun) return;
    setIsRunningNow(true);
    const baselineLastRunAt = detail.cron.last_run_at ?? null;
    try {
      const next = await cronAction(detail.cron.id, 'run');
      applyCron(next);
      // The scheduler ticks every 60s, so the new run output won't appear
      // immediately. Show a placeholder row at the top of History and poll
      // until last_run_at advances past our baseline (or we time out).
      setPendingRun({ startedAt: Date.now() });
      startPendingPoll(detail.cron.id, baselineLastRunAt);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunningNow(false);
    }
  };

  const startPendingPoll = useCallback((cronId: string, baselineLastRunAt: string | null) => {
    if (pendingPollRef.current !== null) {
      window.clearInterval(pendingPollRef.current);
    }
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60_000; // 5 minutes — Hermes' tick is 60s, plus run time.
    const POLL_MS = 3000;
    const tick = async () => {
      try {
        const next = await getCronDetail(cronId);
        const advanced = next.cron.last_run_at && next.cron.last_run_at !== baselineLastRunAt;
        if (advanced) {
          stopPendingPoll();
          setDetail(next);
          // Auto-expand the newest run so the user sees the result.
          const newest = next.runs[0];
          if (newest) setExpandedRun(newest.filename);
          const ok = next.cron.last_status !== 'error';
          toast.show({
            title: ok ? 'Routine finished' : 'Routine failed',
            description: ok ? next.cron.name : (next.cron.last_error ?? 'Run errored.'),
            tone: ok ? 'success' : 'error',
            action: newest
              ? {
                label: 'View',
                onClick: () => setExpandedRun(newest.filename),
              }
              : undefined,
          });
          return;
        }
        if (Date.now() - startedAt > TIMEOUT_MS) {
          stopPendingPoll();
          toast.show({
            title: 'Still running',
            description: 'The routine is taking longer than expected. Refresh to check again.',
            tone: 'info',
          });
        }
      } catch {
        // Transient errors during polling are ignored — the next tick retries.
      }
    };
    pendingPollRef.current = window.setInterval(() => { void tick(); }, POLL_MS);
    // Run once immediately so a fast run lands without waiting 3s.
    void tick();
  }, [toast]);

  const handleSaveDescription = async () => {
    if (!detail) return;
    const trimmed = descriptionDraft.trim();
    if (trimmed === (description?.text ?? '')) {
      setIsEditingDescription(false);
      return;
    }
    try {
      const updated = await patchCronDescription(detail.cron.id, trimmed);
      setDescription(updated);
      setDescriptionDraft(updated?.text ?? '');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsEditingDescription(false);
    }
  };

  const stopPendingPoll = () => {
    if (pendingPollRef.current !== null) {
      window.clearInterval(pendingPollRef.current);
      pendingPollRef.current = null;
    }
    setPendingRun(null);
  };

  const handleEditInChat = async () => {
    if (!detail || isOpeningInChat) return;
    setIsOpeningInChat(true);
    try {
      const session = await createChatSession(`Editing ${detail.cron.name}`);
      // App.tsx routes vervo:select-session to the freshly created session,
      // and vervo:attach-cron drops the chip into that session's draft.
      window.dispatchEvent(new CustomEvent('vervo:attach-cron', {
        detail: { id: detail.cron.id, name: detail.cron.name, sessionId: session.id },
      }));
      window.dispatchEvent(new CustomEvent('vervo:select-session', {
        detail: { sessionId: session.id },
      }));
      onBack();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsOpeningInChat(false);
    }
  };

  const refetch = async () => {
    try {
      const next = await getCronDetail(id);
      setDetail(next);
    } catch {
      // Best effort — the toolbar already reflects the last action.
    }
  };

  const handleToggleRun = async (run: CronRunSummaryView) => {
    if (expandedRun === run.filename) {
      setExpandedRun(null);
      return;
    }
    setExpandedRun(run.filename);
    if (runContent[run.filename] !== undefined) return;
    setRunLoading(run.filename);
    try {
      const [content, transcript] = await Promise.all([
        getCronRunOutput(id, run.filename),
        getCronRunTranscript(id, run.filename).catch(() => null),
      ]);
      setRunContent((prev) => ({ ...prev, [run.filename]: content }));
      setRunTranscript((prev) => ({ ...prev, [run.filename]: transcript }));
      setRunError((prev) => {
        const { [run.filename]: _removed, ...rest } = prev;
        return rest;
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setRunError((prev) => ({ ...prev, [run.filename]: message }));
    } finally {
      setRunLoading((prev) => (prev === run.filename ? null : prev));
    }
  };

  return (
    <div className="skill-page">
      <div className="skill-page-inner">
        <button type="button" className="catalog-overlay-back" onClick={onBack}>
          ← Back
        </button>

        {isLoading && !detail && <div className="catalog-overlay-empty">Loading routine…</div>}
        {error && <div className="catalog-overlay-error">{error}</div>}

        {detail && (
          <>
            <div className="skill-detail-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  type="text"
                  className="cron-detail-name"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={onNameBlur}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  aria-label="Routine name"
                />

                <CronDescriptionBlock
                  description={description}
                  isGenerating={isGeneratingDescription}
                  isEditing={isEditingDescription}
                  draft={descriptionDraft}
                  onDraftChange={setDescriptionDraft}
                  onStartEdit={() => setIsEditingDescription(true)}
                  onSave={() => { void handleSaveDescription(); }}
                  onCancelEdit={() => {
                    setDescriptionDraft(description?.text ?? '');
                    setIsEditingDescription(false);
                  }}
                />
              </div>
              <span
                className={`skill-row-toggle is-${detail.cron.state === 'paused' ? 'off' : 'on'}${isToggling ? ' is-loading' : ''}`}
                role="switch"
                aria-checked={detail.cron.state !== 'paused'}
                onClick={handleToggleState}
                title={detail.cron.state === 'paused' ? 'Resume' : 'Pause'}
              >
                <span className="skill-row-toggle-thumb" />
              </span>
            </div>

            <div className="skill-detail-actions cron-detail-actions">
              <button
                type="button"
                className="skill-detail-action is-primary"
                onClick={handleRunNow}
                disabled={isRunningNow}
              >
                {isRunningNow ? 'Running…' : 'Run now'}
              </button>
              <button
                type="button"
                className="cron-detail-secondary cron-detail-edit-chat"
                onClick={() => { void handleEditInChat(); }}
                disabled={isOpeningInChat}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12.5V13a1 1 0 0 0 1 1h.5L12 6.5 9.5 4 2 11.5V12a.5.5 0 0 0 .5.5H3z" />
                  <path d="M11 4.5 12.5 3 13 2.5 13.5 3 14 3.5 12.5 5 11 4.5z" />
                </svg>
                <span>{isOpeningInChat ? 'Opening…' : 'Edit in chat'}</span>
              </button>
            </div>

            <div className="cron-detail-section">
              <div className="cron-detail-section-label">SCHEDULE</div>
              <div className="cron-detail-schedule-meta">
                {buildScheduleMetaLine(detail.cron) || '—'}
              </div>
            </div>

            <div className="cron-detail-section">
              <div className="cron-detail-section-label">PROMPT</div>
              <textarea
                className="cron-detail-textarea"
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                onBlur={onPromptBlur}
                rows={Math.min(12, Math.max(4, promptDraft.split('\n').length + 1))}
              />
            </div>

            <div className="cron-detail-section">
              <div className="cron-detail-section-label">HISTORY</div>
              {detail.runs.length === 0 && !pendingRun ? (
                <div className="cron-detail-empty">No runs yet.</div>
              ) : (
                <div className="cron-run-list">
                  {pendingRun && (
                    <PendingRunRow startedAt={pendingRun.startedAt} />
                  )}
                  {detail.runs.map((run, idx) => {
                    const isOpen = expandedRun === run.filename;
                    const content = runContent[run.filename];
                    const transcript = runTranscript[run.filename];
                    const loadErr = runError[run.filename];
                    // The newest (idx 0) run inherits the cron's last_status —
                    // older runs don't have per-run status stored, so we leave
                    // their dot neutral.
                    const statusForRow = idx === 0
                      ? (detail.cron.last_status ?? null)
                      : null;
                    return (
                      <div key={run.filename} className={`cron-run-row${isOpen ? ' is-open' : ''}`}>
                        <button
                          type="button"
                          className="cron-run-row-header"
                          onClick={() => { void handleToggleRun(run); }}
                        >
                          <RunStatusDot status={statusForRow} />
                          <span className="cron-run-row-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                          <span className="cron-run-row-ts">{formatTimestamp(run.modified)}</span>
                          <span className="cron-run-row-size">{formatBytes(run.size)}</span>
                        </button>
                        {isOpen && (
                          <div className="cron-run-row-body">
                            {runLoading === run.filename && <div className="cron-detail-empty">Loading…</div>}
                            {loadErr && <div className="catalog-overlay-error">{loadErr}</div>}
                            {transcript && transcript.messages.length > 0 && (
                              <RunTranscriptView messages={transcript.messages} />
                            )}
                            {!transcript && content !== undefined && (
                              <div className="cron-detail-empty">Tool transcript not available for this run.</div>
                            )}
                            {content !== undefined && (
                              <details className="cron-run-raw" open={!transcript}>
                                <summary>Final response</summary>
                                <div className="cron-run-content message-content">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{extractResponseSection(content) ?? content}</ReactMarkdown>
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return iso;
  const abs = Math.abs(ms);
  const future = ms >= 0;
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return future ? 'now' : 'just now';
  const value = minutes < 60
    ? `${minutes}m`
    : minutes < 60 * 48
      ? `${Math.round(minutes / 60)}h`
      : `${Math.round(minutes / 60 / 24)}d`;
  // Future reads naturally as a prefix ("in 4h"); past reads naturally as a
  // suffix ("4h ago"). Returning each in its native shape lets call sites
  // compose without producing "last run ago 4h".
  return future ? `in ${value}` : `${value} ago`;
}

// `next_run_at` lands in the past during the brief window between "Run now"
// (or any overdue schedule) and the scheduler's 60s tick — render that as
// "starting…" so the user doesn't see "next 15 sec ago".
function formatNextRun(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isNaN(ms) && ms < 0) return 'starting…';
  return `next ${formatRelative(iso)}`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function CronDescriptionBlock({
  description,
  isGenerating,
  isEditing,
  draft,
  onDraftChange,
  onStartEdit,
  onSave,
  onCancelEdit,
}: {
  description: CronDescriptionView | null;
  isGenerating: boolean;
  isEditing: boolean;
  draft: string;
  onDraftChange: (next: string) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
}) {
  if (isEditing) {
    return (
      <div className="cron-description is-editing">
        <textarea
          className="cron-description-input"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={onSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          autoFocus
          rows={2}
          maxLength={280}
          placeholder="Describe what this routine does"
        />
      </div>
    );
  }

  if (isGenerating && !description) {
    return (
      <div className="cron-description is-generating">
        <span className="cron-description-shimmer" aria-hidden="true" />
        <span className="cron-description-shimmer-label">Summarising routine…</span>
      </div>
    );
  }

  return (
    <div className="cron-description">
      <button
        type="button"
        className="cron-description-text"
        onClick={onStartEdit}
        title="Click to edit"
      >
        {description?.text ?? 'No summary yet — click to add one.'}
      </button>
    </div>
  );
}

// Composes the human-language schedule line shown in the SCHEDULE section:
// "At 12:00 PM · next in 19h · last run 5h ago". Edits to schedule itself
// happen via "Edit in chat" — the detail page is read-only for this field.
function buildScheduleMetaLine(cron: CronJobView): string {
  const parts: string[] = [];
  const humanized = humanizeSchedule(cron.schedule_display ?? '');
  if (humanized) parts.push(humanized);
  if (cron.state === 'paused') {
    parts.push('Paused');
  } else if (cron.next_run_at) {
    parts.push(capitalize(formatNextRun(cron.next_run_at)));
  }
  if (cron.last_run_at) {
    const failed = cron.last_status === 'error' ? ' (failed)' : '';
    parts.push(`Last run ${formatRelative(cron.last_run_at)}${failed}`);
  }
  return parts.join(' · ');
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function extractResponseSection(markdown: string): string | null {
  // Hermes' run output starts with metadata + the prompt + a "## Response"
  // section containing the agent's final reply. Strip everything before the
  // response so the "Final response" disclosure shows just that.
  const idx = markdown.indexOf('\n## Response');
  if (idx < 0) return null;
  const after = markdown.slice(idx + '\n## Response'.length).replace(/^\s*\n/, '');
  return after.length > 0 ? after : null;
}

function PendingRunRow({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const handle = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <div className="cron-run-row is-pending">
      <div className="cron-run-row-header" aria-disabled="true">
        <span className="cron-run-spinner" aria-hidden="true" />
        <span className="cron-run-row-ts">Running… {formatElapsed(elapsed)}</span>
        <span className="cron-run-row-size">just now</span>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

function RunStatusDot({ status }: { status: string | null }) {
  let className = 'cron-run-status-dot';
  if (status === 'ok') className += ' is-ok';
  else if (status === 'error') className += ' is-error';
  else className += ' is-neutral';
  return <span className={className} aria-hidden="true" />;
}

function RunTranscriptView({ messages }: { messages: CronRunTranscriptMessage[] }) {
  // Walk the message list, rendering tool-call requests + their paired
  // results inline. Final assistant text (with no tool_calls) is the
  // agent's user-visible answer.
  const toolResultsByCall = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      toolResultsByCall.set(m.tool_call_id, content);
    }
  }

  const rendered: ReactNode[] = [];
  let key = 0;
  for (const m of messages) {
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const call of calls) {
        const callId = call.id ?? '';
        const name = call.function?.name ?? 'tool';
        const args = call.function?.arguments ?? '';
        const result = callId ? toolResultsByCall.get(callId) ?? null : null;
        rendered.push(
          <TranscriptToolStep key={`tc-${key++}`} name={name} args={args} result={result} />,
        );
      }
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (text.length > 0 && calls.length === 0) {
        // Final assistant reply (or interim prose with no tool calls).
        rendered.push(
          <div key={`at-${key++}`} className="cron-run-transcript-text">{text}</div>,
        );
      }
    }
    // user/tool messages without an assistant pair are skipped — they're
    // either the initial prompt (already shown above the History section)
    // or already attached to a tool call above.
  }
  if (rendered.length === 0) {
    return <div className="cron-detail-empty">Transcript empty.</div>;
  }
  return <div className="cron-run-transcript">{rendered}</div>;
}

function TranscriptToolStep({ name, args, result }: { name: string; args: string; result: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const preview = previewArgs(args);
  return (
    <div className="cron-run-transcript-tool">
      <button
        type="button"
        className="cron-run-transcript-tool-row"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="cron-run-transcript-tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="cron-run-transcript-tool-name">{name}</span>
        {preview && !expanded && <span className="cron-run-transcript-tool-preview">{preview}</span>}
      </button>
      {expanded && (
        <div className="cron-run-transcript-tool-detail">
          {args && (
            <pre className="cron-run-transcript-payload"><span className="cron-run-transcript-payload-label">Arguments</span>{prettyJson(args)}</pre>
          )}
          {result && (
            <pre className="cron-run-transcript-payload"><span className="cron-run-transcript-payload-label">Result</span>{prettyJson(result)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function previewArgs(args: string): string {
  if (!args) return '';
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const first = Object.entries(parsed)[0];
      if (first) {
        const [k, v] = first;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${truncate(s, 80)}`;
      }
    }
  } catch {
    // not JSON
  }
  return truncate(args, 80);
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
