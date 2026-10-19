import { test, expect } from './fixtures';
import en from '../src/locales/en.json' with { type: 'json' };
import vi from '../src/locales/vi.json' with { type: 'json' };
import hi from '../src/locales/hi.json' with { type: 'json' };

const report = { asOf: '2026-10-19', days: 7, record: { from: '2026-09-07', to: '2026-09-13', receivableUsd: '123.45000000' } };
const headers = { 'x-ccmax-request': '1' };
const languages = [
  { locale: 'zh-CN', catalog: null, amount: '$123.45', unit: '$0.1200' },
  { locale: 'en', catalog: en, amount: '$123.45', unit: '$0.1200' },
  { locale: 'vi', catalog: vi, amount: '123,45\u00a0US$', unit: '0,1200\u00a0US$' },
  { locale: 'hi', catalog: hi, amount: '$123.45', unit: '$0.1200' },
] as const;
const translated = (catalog: Record<string, string> | null, source: string) => catalog?.[source] ?? source;
const description = '让闲置 Claude Max 额度产生收益。查看专属结算报价，添加账号，追踪有账单依据的实际应收。';
const historicalMessage = '单账号历史 7 天收益最高 {0}！';

test('historical record displays the supplied verified week, dates and basis across landing, invitation, promotion and languages', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  // The browser uses a controlled aggregate. The actual rolling-week query is
  // exercised against real database bills in server/monetization.test.ts.
  await page.route('**/api/marketing/weekly-record', route => route.fulfill({ json: report }));
  await page.goto('/');
  await expect(page.getByTestId('historical-weekly-peak')).toContainText('$123.45');
  await expect(page.locator('.historical-weekly-peak')).toContainText('2026-09-07 — 2026-09-13');
  await expect(page.locator('.login-value-card')).toHaveCount(0);
  for (const { locale, catalog, amount } of languages) {
    await page.locator('.language-switcher select').selectOption(locale);
    await expect(page.getByTestId('historical-weekly-peak')).toContainText(amount);
    await expect(page.locator('.historical-weekly-peak')).toContainText(translated(catalog, '历史单账号最高 7 天已核实应收'));
    await expect(page).toHaveTitle(translated(catalog, 'CCMAX · Max 账号收益工作空间'));
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', translated(catalog, description));
  }
  await page.locator('.language-switcher select').selectOption('zh-CN');
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
  for (const { locale, catalog, amount } of languages) {
    await page.locator('.language-switcher select').selectOption(locale);
    await campaign.getByRole('button', { name: translated(catalog, '复制推广文案') }).click();
    const promotion = await page.evaluate(() => navigator.clipboard.readText());
    const expectedRecord = translated(catalog, historicalMessage).replace('{0}', amount);
    expect(promotion).toBe(`${expectedRecord}\n${translated(catalog, '闲置 Claude Max，立即加入 CCMAX 变现：')}\n${invitation.url}`);
    if (locale !== 'zh-CN') expect(promotion).not.toMatch(/[\u3400-\u9fff]/u);
  }
  await page.locator('.language-switcher select').selectOption('zh-CN');
  await page.request.post('/api/auth/logout', { headers, data: {} });
  await page.goto(invitation.url);
  await expect(page.getByTestId('historical-weekly-peak')).toContainText('$123.45');
  await expect(page.getByTestId('unit-earnings')).toHaveText('$0.1200');
  await expect(page.locator('.historical-weekly-peak')).toContainText('未扣订阅及代理成本');
  await page.screenshot({ path: 'test-results/historical-record-invite-desktop.png', fullPage: true });
  await page.locator('input[name="name"]').fill('Keep my signup input');
  for (const { locale, catalog, amount, unit } of languages) {
    await page.locator('.language-switcher select').selectOption(locale);
    await expect(page.locator('.historical-weekly-peak')).toContainText(translated(catalog, '历史单账号最高 7 天已核实应收'));
    await expect(page.getByTestId('historical-weekly-peak')).toContainText(amount);
    await expect(page.getByTestId('unit-earnings')).toHaveText(unit);
    await expect(page.getByRole('button', { name: translated(catalog, '立即注册，添加账号'), exact: true })).toBeEnabled();
    await expect(page.locator('input[name="name"]')).toHaveValue('Keep my signup input');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', translated(catalog, description));
    if (locale !== 'zh-CN') expect(await page.locator('.historical-weekly-peak').innerText()).not.toMatch(/[\u3400-\u9fff]/u);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/historical-record-invite-mobile-${locale}.png`, fullPage: true });
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
