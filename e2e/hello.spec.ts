import { expect, test } from '@playwright/test';

test('healthz responds', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true });
});

test('home page loads and reaches the server', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Carrier Docs' })).toBeVisible();
  await expect(page.getByTestId('health')).toHaveText('Server: ok');
});
