import { json, route, type Route } from './router.ts';
import {
  ComposioBridgeHttpError,
  resolvePendingDraft,
  type ComposioBridgeService,
  type DraftResolution,
} from '../integrations/composio-bridge.ts';

interface ApprovePayload {
  channel: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  threadId: string;
  wasEdited: boolean;
}

// Channels where Verso handles the actual send itself (cleanest UX — agent
// gets a `status: 'sent'` result and doesn't need to make a follow-up tool
// call). Any other channel falls through to the generic `approved` path,
// where the agent dispatches the send tool of its choice.
const NATIVE_DISPATCH: Record<string, { slug: string; buildArgs: (p: ApprovePayload) => Record<string, unknown> }> = {
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

export function buildDraftsRoutes(bridge: ComposioBridgeService): Route[] {
  return [
    // POST /drafts/:id/approve — user confirmed (possibly edited).
    // For Gmail/Slack: Verso dispatches the send directly here, then resolves
    // the held tool call with status='sent' so the agent doesn't need to make
    // a second tool call. For any other channel: resolve with status='approved'
    // and the agent handles dispatch using the final_* values.
    route('POST', '/drafts/:id/approve', async (_req, res, params, body) => {
      let payload: ApprovePayload;
      try {
        payload = parseApprovePayload(body);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, 400, { error: 'bad_request', message });
      }

      const native = NATIVE_DISPATCH[payload.channel];
      if (native) {
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
          const resolution: DraftResolution = {
            status: 'sent',
            channel: payload.channel,
            sent_via: native.slug,
            was_edited: payload.wasEdited,
            result: result.data,
          };
          const resolved = resolvePendingDraft(params.id, resolution);
          if (!resolved) {
            return json(res, 410, {
              error: 'not_pending',
              message: 'This draft is no longer pending — it may have already been resolved or timed out.',
            });
          }
          return json(res, 200, { status: 'sent', draftId: params.id, toolSlug: native.slug });
        } catch (error: unknown) {
          if (error instanceof ComposioBridgeHttpError) {
            return json(res, error.status, { error: 'send_failed', message: error.message });
          }
          const message = error instanceof Error ? error.message : String(error);
          return json(res, 500, { error: 'internal_error', message });
        }
      }

      // Generic path: hand the (edited) envelope back to the agent and let
      // it pick the Composio send tool to call next.
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

    // POST /drafts/:id/reject — user discarded.
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

function parseApprovePayload(body: unknown): ApprovePayload {
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
  };
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}
