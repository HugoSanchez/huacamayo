import { json, route, type Route } from './router.ts';
import { ChatStore } from './chat-store.ts';
import {
  ComposioBridgeHttpError,
  NATIVE_DRAFT_CHANNELS,
  resolvePendingDraft,
  type ComposioBridgeService,
  type DraftResolution,
} from '../integrations/composio-bridge.ts';

interface DraftPayload {
  channel: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  threadId: string;
  wasEdited: boolean;
  sessionId: string;
  draftId: string;
}

// Native channels: Verso dispatches the send directly from the widget's Send
// button. The model already ended its turn after proposing, so this path
// never touches the held-draft registry — it just fires the Composio tool.
const NATIVE_DISPATCH: Record<string, { slug: string; buildArgs: (p: DraftPayload) => Record<string, unknown> }> = {
  gmail: {
    slug: 'GMAIL_SEND_EMAIL',
    buildArgs: (p) => {
      const args: Record<string, unknown> = {
        recipient_email: p.to,
        subject: p.subject,
        body: p.body,
        is_html: false,
      };
      if (p.cc) args.cc = p.cc.split(',').map((value) => value.trim()).filter(Boolean);
      return args;
    },
  },
  slack: {
    slug: 'SLACK_SEND_MESSAGE',
    buildArgs: (p) => {
      const args: Record<string, unknown> = {
        channel: p.to.replace(/^#/, ''),
        text: p.body,
      };
      if (p.threadId) args.thread_ts = p.threadId;
      return args;
    },
  },
};

export function buildDraftsRoutes(bridge: ComposioBridgeService, store: ChatStore): Route[] {
  return [
    // POST /drafts/send — native channels (Slack/Gmail). Dispatches the send
    // directly and returns the result. No held draft involved; the model is
    // not re-engaged. This is the fast, native-feeling path.
    route('POST', '/drafts/send', async (_req, res, _params, body) => {
      let payload: DraftPayload;
      try {
        payload = parseDraftPayload(body);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, 400, { error: 'bad_request', message });
      }

      const native = NATIVE_DISPATCH[payload.channel];
      if (!native) {
        return json(res, 400, {
          error: 'bad_request',
          message: `Channel "${payload.channel}" is not dispatched by Verso — use the approval flow instead.`,
        });
      }
      if (!payload.sessionId) {
        return json(res, 400, { error: 'bad_request', message: 'Field "sessionId" is required' });
      }
      if (!payload.draftId) {
        return json(res, 400, { error: 'bad_request', message: 'Field "draftId" is required' });
      }
      if (!store.getSessionRecord(payload.sessionId)) {
        return json(res, 404, {
          error: 'not_found',
          message: `Unknown session: ${payload.sessionId}`,
        });
      }

      try {
        const result = await bridge.executeTool(native.slug, native.buildArgs(payload));
        if (result.error) {
          return json(res, 502, {
            error: 'send_failed',
            message: result.error,
            channel: payload.channel,
            toolSlug: native.slug,
          });
        }
        store.recordDraftResolution(payload.sessionId, payload.draftId, 'sent', payload.channel);
        json(res, 200, { status: 'sent', channel: payload.channel, toolSlug: native.slug, result: result.data });
      } catch (error: unknown) {
        if (error instanceof ComposioBridgeHttpError) {
          return json(res, error.status, { error: 'send_failed', message: error.message });
        }
        const message = error instanceof Error ? error.message : String(error);
        json(res, 500, { error: 'internal_error', message });
      }
    }),

    // POST /drafts/:id/discard — native channels only. There is no held tool
    // call to resolve for these, but the local chat history still needs a
    // durable final state so reopened sessions do not resurrect stale widgets.
    route('POST', '/drafts/:id/discard', async (_req, res, params, body) => {
      const payload = parseDiscardPayload(body);
      if (!payload.sessionId) {
        return json(res, 400, { error: 'bad_request', message: 'Field "sessionId" is required' });
      }
      if (!payload.channel) {
        return json(res, 400, { error: 'bad_request', message: 'Field "channel" is required' });
      }
      if (!NATIVE_DRAFT_CHANNELS.has(payload.channel)) {
        return json(res, 400, {
          error: 'bad_request',
          message: `Channel "${payload.channel}" is not dispatched by Verso — use the rejection flow instead.`,
        });
      }
      const resolution = store.recordDraftResolution(payload.sessionId, params.id, 'discarded', payload.channel);
      if (!resolution) {
        return json(res, 404, {
          error: 'not_found',
          message: `Unknown session: ${payload.sessionId}`,
        });
      }
      json(res, 200, { status: 'discarded', draftId: params.id });
    }),

    // POST /drafts/:id/approve — generic channels only. Resolves the held
    // tool call with the (possibly edited) final values so the agent
    // dispatches the send itself.
    route('POST', '/drafts/:id/approve', async (_req, res, params, body) => {
      let payload: DraftPayload;
      try {
        payload = parseDraftPayload(body);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, 400, { error: 'bad_request', message });
      }

      const resolution: DraftResolution = {
        status: 'approved',
        was_edited: payload.wasEdited,
        channel: payload.channel,
        final_to: payload.to,
        final_cc: payload.cc,
        final_subject: payload.subject,
        final_body: payload.body,
        final_thread_id: payload.threadId,
      };
      const resolved = resolvePendingDraft(params.id, resolution);
      if (!resolved) {
        return json(res, 410, {
          error: 'not_pending',
          message: 'This draft is no longer pending — it may have already been resolved or timed out.',
        });
      }
      json(res, 200, { status: 'approved', draftId: params.id });
    }),

    // POST /drafts/:id/reject — generic channels only. The held tool call
    // resolves with status='rejected'; the agent acknowledges and moves on.
    route('POST', '/drafts/:id/reject', async (_req, res, params) => {
      const resolved = resolvePendingDraft(params.id, {
        status: 'rejected',
        reason: 'discarded_by_user',
      });
      if (!resolved) {
        return json(res, 410, {
          error: 'not_pending',
          message: 'This draft is no longer pending — it may have already been resolved or timed out.',
        });
      }
      json(res, 200, { status: 'rejected', draftId: params.id });
    }),
  ];
}

// Exposed so the chat UI side and tests can agree on which channels skip the
// approval round-trip.
export { NATIVE_DRAFT_CHANNELS };

function parseDraftPayload(body: unknown): DraftPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Missing JSON body');
  }
  const record = body as Record<string, unknown>;
  const channel = stringField(record.channel);
  const to = stringField(record.to);
  const body_ = stringField(record.body);
  if (!channel) throw new Error('Field "channel" is required');
  if (!to) throw new Error('Field "to" is required');
  if (!body_) throw new Error('Field "body" is required');
  return {
    channel,
    to,
    cc: stringField(record.cc),
    subject: stringField(record.subject),
    body: body_,
    threadId: stringField(record.threadId),
    wasEdited: record.wasEdited === true,
    sessionId: stringField(record.sessionId),
    draftId: stringField(record.draftId),
  };
}

function parseDiscardPayload(body: unknown): { sessionId: string; channel: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { sessionId: '', channel: '' };
  }
  const record = body as Record<string, unknown>;
  return {
    sessionId: stringField(record.sessionId),
    channel: stringField(record.channel),
  };
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}
