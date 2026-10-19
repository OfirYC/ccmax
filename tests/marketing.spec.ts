import { test, expect } from './fixtures';
import en from '../src/locales/en.json' with { type: 'json' };
import vi from '../src/locales/vi.json' with { type: 'json' };
import hi from '../src/locales/hi.json' with { type: 'json' };

const report = { asOf: '2026-10-19', days: 7, record: { from: '2026-09-07', to: '2026-09-13', receivableUsd: '123.45000000' } };
const headers = { 'x-ccmax-request': '1' };

test('historical record displays the supplied verified week, dates and basis across landing, invitation, promotion and languages', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  // The browser uses a controlled aggregate. The actual rolling-week query is
  // exercised against real database bills in server/monetization.test.ts.
  await page.route('**/api/marketing/weekly-record', route => route.fulfill({ json: report }));
  await page.goto('/');
  await expect(page.getByTestId('historical-weekly-peak')).toContainText('$123.45');
  await expect(page.locator('.historical-weekly-peak')).toContainText('2026-09-07 — 2026-09-13');
  await expect(page.locator('.login-value-card')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/historical-record-login-desktop.png', fullPage: true });
  expect((await page.request.post('/api/auth/login', { headers, data: { email: 'owner@example.com', password: 'e2e-owner-password' } })).ok()).toBe(true);
  const response = await page.request.post('/api/team/invitations', { headers, data: { name: 'Historical record campaign', rates: { ai008: 0.12 } } });
  expect(response.ok()).toBe(true);
  const invitation = (await response.json()).invitation;
  await page.goto('/team');
  const campaign = page.locator('.team-invitations').getByRole('row').filter({ hasText: 'Historical record campaign' });
  await expect(campaign).toBeVisible();
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/api/marketing/weekly-record')))).toBe(true);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await campaign.getByRole('button', { name: '复制推广文案' }).click();
  const promotion = await page.evaluate(() => navigator.clipboard.readText());
  expect(promotion).toContain('$123.45'); expect(promotion).toContain('2026-09-07'); expect(promotion).toContain(invitation.url);
  await page.request.post('/api/auth/logout', { headers, data: {} });
  await page.goto(invitation.url);
  await expect(page.getByTestId('historical-weekly-peak')).toContainText('$123.45');
  await expect(page.getByTestId('unit-earnings')).toHaveText('$0.1200');
  await expect(page.locator('.historical-weekly-peak')).toContainText('未扣订阅及代理成本');
  await page.screenshot({ path: 'test-results/historical-record-invite-desktop.png', fullPage: true });
  for (const [locale, catalog] of [['en', en], ['vi', vi], ['hi', hi]] as const) {
    await page.locator('.language-switcher select').selectOption(locale);
    await expect(page.locator('.historical-weekly-peak')).toContainText(catalog['历史单账号最高 7 天已核实应收']);
    expect(await page.locator('.historical-weekly-peak').innerText()).not.toMatch(/[\u3400-\u9fff]/u);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator('.language-switcher select').selectOption('zh-CN');
  await page.screenshot({ path: 'test-results/historical-record-invite-mobile.png', fullPage: true });
});

test('missing complete weeks and failed record requests keep signup usable without an invented record', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  let fail = false;
  await page.route('**/api/marketing/weekly-record', route => fail ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: { ...report, record: null } }));
  await page.goto('/');
  await expect(page.locator('.login-value-card')).toBeVisible();
  await expect(page.getByTestId('historical-weekly-peak')).toHaveCount(0);
  fail = true;
  await page.reload();
  await expect(page.getByRole('button', { name: '进入工作空间' })).toBeEnabled();
  await expect(page.getByTestId('historical-weekly-peak')).toHaveCount(0);
});
