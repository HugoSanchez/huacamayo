import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/http/server.ts';

/**
 * Agent endpoint tests.
 *
 * These test the HTTP layer (SSE format, status, stop).
 * The actual SDK query requires a Claude API key, so we test
 * the endpoints in isolation — validation, status tracking, etc.
 */
describe('Agent HTTP Endpoints', () => {
  let server: http.Server | null = null;
  let port = 0;
  let tmpDir = '';

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'research-core-agent-test-'));
    const dbPath = path.join(tmpDir, 'brain.db');
    const result = await startServer({ port: 0, databasePath: dbPath, skipConfig: true });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) {
      server.close();
      server = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url(path), init);
    const body = await res.json();
    return { status: res.status, body };
  }

  // ── GET /agent/status ──────────────────────────────────────

  describe('GET /agent/status', () => {
    it('returns idle status initially', async () => {
      const { status, body } = await fetchJson('/agent/status');
      expect(status).toBe(200);
      expect(body.status).toBe('idle');
      expect(body.hasActiveQuery).toBe(false);
      expect(body.lastError).toBe(null);
    });
  });

  // ── GET /agent/context/resolve ─────────────────────────────

  describe('GET /agent/context/resolve', () => {
    it('reports no_contexts when there are no sources/contexts', async () => {
      const { status, body } = await fetchJson('/agent/context/resolve');
      expect(status).toBe(200);
      expect(body.resolution.kind).toBe('no_contexts');
      expect(body.counts.sources).toBe(0);
      expect(body.counts.contexts).toBe(0);
    });

    it('auto-bootstraps default context when sources exist', async () => {
      const createdSource = await fetch(url('/sources'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'src-1',
          name: 'Source 1',
          location: '/tmp/source-1',
          type: 'folder',
        }),
      });
      expect(createdSource.status).toBe(201);

      const { status, body } = await fetchJson('/agent/context/resolve?sessionId=session-1');
      expect(status).toBe(200);
      expect(body.resolution.kind).toBe('resolved');
      expect(body.resolution.contextId).toBe('default');
      expect(body.resolution.source).toBe('bootstrap');
      expect(body.counts.sources).toBe(1);
      expect(body.counts.contexts).toBe(1);
    });
  });

  // ── POST /agent/stop ───────────────────────────────────────

  describe('POST /agent/stop', () => {
    it('returns no_active_query when nothing is running', async () => {
      const { status, body } = await fetchJson('/agent/stop', { method: 'POST' });
      expect(status).toBe(200);
      expect(body.status).toBe('no_active_query');
    });
  });

  // ── POST /agent/query ──────────────────────────────────────

  describe('POST /agent/query', () => {
    it('rejects missing prompt', async () => {
      const { status, body } = await fetchJson('/agent/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
      expect(body.error).toBe('bad_request');
      expect(body.message).toContain('prompt');
    });

    it('returns no-knowledge-base message when no context can be resolved', async () => {
      const res = await fetch(url('/agent/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello', contextId: 'missing-context' }),
      });

      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const body = await res.text();
      expect(body).toContain('"type":"result"');
      expect(body).toContain("I couldn't find information about that in your knowledge base right now.");
      expect(body).toContain('"type":"done"');
    });
  });
});
