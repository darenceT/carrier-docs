import { expect, test } from '@playwright/test';

test('healthz responds', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ ok: true });
});

test('home page loads and reaches the server', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Carrier Docs' })).toBeVisible();
  await expect(page.getByTestId('health')).toHaveText('Server: ok');
});

test('offers a reload when the server is redeployed under an open tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('health')).toHaveText('Server: ok');
  await expect(page.getByTestId('new-version')).toHaveCount(0);
  // A redeploy: the server now names another build.
  await page.route('**/healthz', (route) =>
    route.fulfill({ json: { ok: true, version: 'a-newer-build' } }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('new-version')).toContainText('A new version is available');
});
