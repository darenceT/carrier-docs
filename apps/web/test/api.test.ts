import { describe, expect, it } from 'vitest';
import {
  ApiError,
  createApi,
  friendlyError,
  parseErrorResponse,
  type FetchFn,
} from '../src/api.ts';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recordingFetch(response: () => Response) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchFn: FetchFn = async (path, init) => {
    calls.push({ path, init });
    return response();
  };
  return { calls, fetchFn };
}

describe('parseErrorResponse', () => {
  it('parses a contract ErrorBody', async () => {
    const err = await parseErrorResponse(
      jsonResponse(503, { error: { code: 'BUSY', message: 'No free slot', retryable: true } }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'BUSY',
      message: 'No free slot',
      retryable: true,
      status: 503,
    });
  });

  it('falls back on status when the body is not JSON', async () => {
    const err = await parseErrorResponse(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(err).toMatchObject({ code: 'INTERNAL', retryable: true, status: 502 });
  });

  it('falls back on status when the code is unknown', async () => {
    const err = await parseErrorResponse(
      jsonResponse(401, { error: { code: 'NOPE', message: 'x', retryable: false } }),
    );
    expect(err.code).toBe('UNAUTHORIZED');
    const rate = await parseErrorResponse(jsonResponse(429, { message: 'slow' }));
    expect(rate).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });
});

describe('createApi', () => {
  it('posts JSON and parses SessionCreated', async () => {
    const { calls, fetchFn } = recordingFetch(() => jsonResponse(202, { sessionId: 's1' }));
    const api = createApi(fetchFn);
    const res = await api.startSession({
      carrierId: 'demo',
      username: 'u',
      password: 'p',
      prewarmSessionId: 'pw',
    });
    expect(res).toEqual({ sessionId: 's1' });
    expect(calls[0]?.path).toBe('/api/sessions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      carrierId: 'demo',
      username: 'u',
      password: 'p',
      prewarmSessionId: 'pw',
    });
  });

  it('accepts empty 202/204 bodies', async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response(null, { status: 202 }));
    const api = createApi(fetchFn);
    await expect(api.submitMfa('a/b', { code: '123456' })).resolves.toBeUndefined();
    expect(calls[0]?.path).toBe('/api/sessions/a%2Fb/mfa');
    const access = createApi(async () => new Response(null, { status: 204 }));
    await expect(access.access('code')).resolves.toBeUndefined();
  });

  it('throws a typed ApiError from an ErrorBody', async () => {
    const api = createApi(async () =>
      jsonResponse(401, {
        error: { code: 'UNAUTHORIZED', message: 'Access code required', retryable: false },
      }),
    );
    const err = await api.carriers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'UNAUTHORIZED', retryable: false, status: 401 });
  });

  it('turns a network failure into a retryable ApiError', async () => {
    const api = createApi(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await api.forgetMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INTERNAL', retryable: true, status: 0 });
  });

  it('builds event and document URLs', () => {
    const api = createApi(async () => new Response(null));
    expect(api.eventsUrl('s1')).toBe('/api/sessions/s1/events');
    expect(api.documentUrl('s1', 'd 1')).toBe('/api/sessions/s1/documents/d%201');
  });
});

describe('friendlyError', () => {
  it('has the BUSY wording', () => {
    expect(friendlyError('BUSY')).toBe('All login slots are busy, try again in a minute.');
    expect(friendlyError('MFA_TIMEOUT')).toMatch(/in time/);
  });
});
