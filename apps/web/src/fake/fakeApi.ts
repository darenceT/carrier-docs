/**
 * DEV ONLY: an in-browser fake of the API so the UI can be clicked through without a server.
 * Enabled with `VITE_FAKE_API=true npm run dev:web`; main.tsx only imports it when
 * import.meta.env.DEV is true, so it never reaches the production bundle.
 *
 * Script: any access code except "wrong" -> carriers -> prewarm -> start -> mfa_required ->
 * code 123456 (anything else is rejected) -> documents_listed -> document_ready -> done.
 * Username "busy" returns 503 BUSY; username "fail" ends with a retryable CARRIER_UNAVAILABLE.
 */
import type {
  DocumentMeta,
  ErrorBody,
  ErrorCode,
  SessionEvent,
  StepTiming,
} from '@carrier-docs/contracts';
import type { Deps } from '../App.tsx';
import { createApi, type FetchFn } from '../api.ts';
import type { EventSourceLike } from '../events.ts';

const MFA_CODE = '123456';
const ATTEMPTS = 3;

const DOCUMENTS: DocumentMeta[] = [
  {
    id: 'doc-id-card',
    title: 'Auto ID card',
    kind: 'id_card',
    policyNumberMasked: '••••1234',
    mimeType: 'application/pdf',
  },
  {
    id: 'doc-dec',
    title: 'Declarations page',
    kind: 'declarations',
    policyNumberMasked: '••••1234',
    mimeType: 'application/pdf',
  },
];

interface FakeSession {
  id: string;
  username: string;
  startedAt: number;
  timings: StepTiming[];
  attemptsLeft: number;
  emit?: (event: SessionEvent) => void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(status: number, code: ErrorCode, message: string, retryable: boolean): Response {
  const body: ErrorBody = { error: { code, message, retryable } };
  return json(status, body);
}

export function createFakeDeps(): Deps {
  let hasAccess = false;
  let nextId = 1;
  const sessions = new Map<string, FakeSession>();

  const elapsed = (s: FakeSession) => Date.now() - s.startedAt;
  const step = (s: FakeSession, name: string, since: number) =>
    s.timings.push({ step: name, ms: Date.now() - since });
  const status = (s: FakeSession, value: Extract<SessionEvent, { type: 'status' }>['status']) =>
    s.emit?.({ type: 'status', status: value, timings: [...s.timings], elapsedMs: elapsed(s) });

  async function runLogin(s: FakeSession) {
    const t0 = Date.now();
    status(s, 'logging_in');
    await delay(900);
    step(s, 'login', t0);
    if (s.username === 'fail') {
      s.emit?.({
        type: 'failed',
        code: 'CARRIER_UNAVAILABLE',
        message: 'Fake carrier is down',
        retryable: true,
      });
      return;
    }
    status(s, 'mfa_required');
    s.emit?.({
      type: 'mfa_required',
      hint: `Code sent by text to •••-•••-1234 (fake: use ${MFA_CODE})`,
      attemptsLeft: s.attemptsLeft,
      lastAttemptRejected: false,
    });
  }

  async function runMfa(s: FakeSession, code: string) {
    const t0 = Date.now();
    status(s, 'verifying_mfa');
    await delay(600);
    if (code !== MFA_CODE) {
      s.attemptsLeft -= 1;
      if (s.attemptsLeft <= 0) {
        s.emit?.({
          type: 'failed',
          code: 'MFA_INVALID',
          message: 'Too many bad codes',
          retryable: true,
        });
        return;
      }
      status(s, 'mfa_required');
      s.emit?.({ type: 'mfa_required', attemptsLeft: s.attemptsLeft, lastAttemptRejected: true });
      return;
    }
    step(s, 'mfa', t0);
    const t1 = Date.now();
    status(s, 'fetching_docs');
    await delay(500);
    step(s, 'list_documents', t1);
    s.emit?.({ type: 'documents_listed', documents: DOCUMENTS });
    const t2 = Date.now();
    await delay(700);
    step(s, 'first_document', t2);
    status(s, 'document_ready');
    s.emit?.({ type: 'document_ready', documentId: DOCUMENTS[0]!.id, elapsedMs: elapsed(s) });
    await delay(200);
    status(s, 'done');
    s.emit?.({ type: 'done' });
  }

  const fakeFetch: FetchFn = async (path, init) => {
    await delay(150);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};

    if (method === 'POST' && path === '/api/access') {
      if (!body.code || body.code === 'wrong') {
        return error(401, 'UNAUTHORIZED', 'Bad access code', false);
      }
      hasAccess = true;
      return json(204);
    }
    if (!hasAccess) return error(401, 'UNAUTHORIZED', 'Access code required', false);

    if (method === 'GET' && path === '/api/carriers') {
      return json(200, {
        carriers: [
          { id: 'demo', name: 'Demo carrier (test fixture)', isDemo: true },
          { id: 'progressive', name: 'Progressive (fake)', isDemo: false },
        ],
      });
    }
    if (method === 'POST' && path === '/api/sessions/prewarm') {
      return json(202, { sessionId: `prewarm-${nextId++}` });
    }
    if (method === 'POST' && path === '/api/sessions') {
      if (body.username === 'busy') {
        return error(503, 'BUSY', 'No free browser', true);
      }
      const s: FakeSession = {
        id: `fake-${nextId++}`,
        username: body.username ?? '',
        startedAt: Date.now(),
        timings: [],
        attemptsLeft: ATTEMPTS,
      };
      sessions.set(s.id, s);
      return json(202, { sessionId: s.id });
    }
    const mfa = /^\/api\/sessions\/([^/]+)\/mfa$/.exec(path);
    if (method === 'POST' && mfa) {
      const s = sessions.get(decodeURIComponent(mfa[1]!));
      if (!s) return error(404, 'NOT_FOUND', 'No such session', false);
      void runMfa(s, body.code ?? '');
      return json(202);
    }
    if (method === 'DELETE' && path === '/api/me') {
      const deleted = sessions.size;
      sessions.clear();
      return json(200, { deleted });
    }
    return error(404, 'NOT_FOUND', `Fake API has no ${method} ${path}`, false);
  };

  const eventSource = (url: string): EventSourceLike => {
    const listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
    const id = decodeURIComponent(/^\/api\/sessions\/([^/]+)\/events$/.exec(url)?.[1] ?? '');
    const source = {
      readyState: 0,
      addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        source.readyState = 2;
        const s = sessions.get(id);
        if (s) s.emit = undefined;
      },
    };
    setTimeout(() => {
      if (source.readyState === 2) return;
      const s = sessions.get(id);
      if (!s) {
        source.readyState = 2;
        for (const l of listeners.get('error') ?? []) l(new MessageEvent('error'));
        return;
      }
      source.readyState = 1;
      s.emit = (event) => {
        const { type, ...data } = event;
        const ev = new MessageEvent(type, { data: JSON.stringify(data) });
        for (const l of listeners.get(type) ?? []) l(ev);
      };
      void runLogin(s);
    }, 50);
    return source;
  };

  const api = createApi(fakeFetch);
  // No server to serve bytes: show a placeholder page in the iframe instead.
  api.documentUrl = (_sessionId, docId) => {
    const doc = DOCUMENTS.find((d) => d.id === docId);
    const html = `<body style="font-family:sans-serif"><h1>${doc?.title ?? docId}</h1><p>Fake document (VITE_FAKE_API).</p></body>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  };

  return { api, eventSource };
}
