import { expect, test } from '@playwright/test';

// playwright.config.ts sets CANARY_CARRIERS=demo: this only loads the local mock portal.
const TOKEN = 'e2e-canary-token-not-secret';

test('the canary loads the Demo login page through the anti-bot layer and reports clean', async ({
  request,
}) => {
  test.setTimeout(60_000);
  expect((await request.post('/internal/canary')).status()).toBe(401);

  const res = await request.post('/internal/canary', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.results).toEqual([
    expect.objectContaining({ carrierId: 'demo', verdict: 'clean', status: 200 }),
  ]);
});
