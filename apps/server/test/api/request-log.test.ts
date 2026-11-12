import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

describe('request logs', () => {
  it('record method, path and status, but no headers (no client IPs, user agent or cookies)', async () => {
    const h = makeHarness();
    const agent = await h.authed();
    await agent
      .get('/api/carriers')
      .set('x-forwarded-for', '203.0.113.7, 108.162.245.240')
      .set('cf-connecting-ip', '203.0.113.7')
      .set('true-client-ip', '203.0.113.7')
      .set('user-agent', 'UA-Should-Not-Appear/1.0');
    const logs = h.logs();
    expect(logs).toContain('"url":"/api/carriers"');
    expect(logs).toContain('"statusCode":200');
    expect(logs).not.toContain('203.0.113.7');
    expect(logs).not.toContain('UA-Should-Not-Appear');
    expect(logs).not.toContain('"headers"');
  });
});
