import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN')); });
import en from '../src/locales/en.json' with { type: 'json' };
import vi from '../src/locales/vi.json' with { type: 'json' };
import hi from '../src/locales/hi.json' with { type: 'json' };

const headers = { 'x-ccmax-request': '1' }, password = 'pricing-browser-password';
async function login(client: APIRequestContext, email: string, pass = password) {
  const response = await client.post('/api/auth/login', { headers, data: { email, password: pass } });
  expect(response.ok(), await response.text()).toBe(true);
}
async function create(client: APIRequestContext, name: string, email: string, B: number) {
  const response = await client.post('/api/team', { headers, data: {
    name, email, password, rates: { A: 0.2, B, C: 0.2 }, effectiveFrom: '1970-01-01',
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).user;
}

test('an upstream cut keeps contracts, shows losses, and requires review of the next layer before bulk capping', async ({ page, request, playwright, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(request, 'owner@example.com', 'e2e-owner-password');
  const parent = await create(request, '批量父代理', 'bulk-parent@example.com', 0.4);
  await login(page.request, 'bulk-parent@example.com');
  const high = await create(page.request, '批量高报价', 'bulk-high@example.com', 0.3);
  const low = await create(page.request, '批量低报价', 'bulk-low@example.com', 0.1);
  const highClient = await playwright.request.newContext({ baseURL });
  try {
    await login(highClient, 'bulk-high@example.com');
    await create(highClient, '下层保留合同', 'bulk-grandchild@example.com', 0.25);
  } finally { await highClient.dispose(); }
  const cut = await request.put(`/api/team/${parent.id}/rates`, { headers, data: { provider: 'B', rate: 0.2 } });
  expect(cut.ok()).toBe(true);
  const tomorrow = (await cut.json()).effectiveDate;
  await page.goto('/');
  await expect(page.getByText('结算价格倒挂提醒', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '代理团队', exact: true }).click();
  const own = page.locator('.own-price-grid>div').filter({ hasText: '平台 B' });
  await expect(own).toContainText('× 0.4000');
  await expect(own).toContainText('× 0.2000');
  const warning = page.locator('.price-risk-details');
  await expect(warning.getByRole('row').filter({ hasText: '批量高报价' })).toContainText('-$10.0000');
  await expect(warning).toContainText(tomorrow);
  await expect(page.locator('body')).not.toContainText('private-upstream-');
  await page.screenshot({ path: 'test-results/pricing-risk-desktop.png', fullPage: true });

  await page.getByRole('button', { name: '批量调价', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量调整直属下级价格' });
  await dialog.getByLabel('调价平台').selectOption('B');
  await dialog.getByRole('button', { name: '选择全部', exact: true }).click();
  await dialog.getByRole('button', { name: '预览调价结果', exact: true }).click();
  const preview = dialog.locator('.batch-preview>.table-scroll');
  await expect(preview.getByRole('row').filter({ hasText: high.name })).toContainText('× 0.2000');
  await expect(preview.getByRole('row').filter({ hasText: low.name })).toContainText('无需变更');
  const downstreamRisk = dialog.locator('.batch-risk');
  await expect(downstreamRisk).toContainText('下层保留合同');
  await expect(downstreamRisk).toContainText('-$5.0000');
  const confirm = dialog.getByRole('button', { name: '确认批量调价', exact: true });
  await expect(confirm).toBeDisabled();
  await page.screenshot({ path: 'test-results/pricing-batch-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await downstreamRisk.getByRole('checkbox').check();
  await confirm.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/pricing-batch-mobile.png', fullPage: true });
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const member = page.locator('.team-members-panel').getByRole('row').filter({ hasText: high.email });
  await expect(member).toContainText('× 0.3000');
  await expect(member).toContainText('待生效 × 0.2000');
  const after = await (await page.request.get('/api/team/pricing')).json();
  expect(after.risks.filter((r: any) => r.kind === 'inverted')).toHaveLength(0);
  const highClientAfter = await playwright.request.newContext({ baseURL });
  try {
    await login(highClientAfter, 'bulk-high@example.com');
    const report = await (await highClientAfter.get('/api/team/pricing')).json();
    expect(report.risks).toContainEqual(expect.objectContaining({ userName: '下层保留合同', date: tomorrow, lossPer100Usd: '5.00000000' }));
  } finally { await highClientAfter.dispose(); }
  expect(errors).toEqual([]);
});

test('bulk scale and fixed updates invalidate stale previews and remain usable in all languages', async ({ page, request }) => {
  await login(request, 'owner@example.com', 'e2e-owner-password');
  await create(request, '预览校验代理', 'preview-parent@example.com', 0.5);
  await login(page.request, 'preview-parent@example.com');
  const child = await create(page.request, '预览校验下级', 'preview-child@example.com', 0.2);
  await page.goto('/team');
  await page.getByRole('button', { name: '批量调价', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('调价平台').selectOption('B');
  await dialog.getByLabel('调价方式').selectOption('scale');
  await dialog.getByLabel('下调比例').fill('0.8');
  await dialog.getByLabel('选择成员 预览校验下级').check();
  await dialog.getByRole('button', { name: '预览调价结果' }).click();
  await expect(dialog.locator('.batch-preview')).toContainText('× 0.1600');
  await dialog.getByLabel('下调比例').fill('0.5');
  await expect(dialog.locator('.batch-preview')).toHaveCount(0);
  await dialog.getByRole('button', { name: '预览调价结果' }).click();
  await expect(dialog.locator('.batch-preview')).toContainText('× 0.1000');
  const update = await page.request.put(`/api/team/${child.id}/rates`, { headers, data: { provider: 'B', rate: 0.25 } });
  expect(update.ok()).toBe(true);
  await dialog.getByRole('button', { name: '确认批量调价' }).click();
  await expect(dialog.getByRole('alert')).toContainText('报价或团队关系已变化，请重新预览后提交');
  await expect(dialog.locator('.batch-preview')).toHaveCount(0);
  await dialog.getByRole('button', { name: '预览调价结果' }).click();
  await expect(dialog.locator('.batch-preview')).toContainText('× 0.1250');
  await dialog.getByRole('button', { name: '确认批量调价' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.team-members-panel')).toContainText('待生效 × 0.1250');

  await page.getByRole('button', { name: '批量调价', exact: true }).click();
  await dialog.getByLabel('调价平台').selectOption('B');
  await dialog.getByLabel('调价方式').selectOption('fixed');
  await dialog.getByLabel('新的统一折扣').fill('0');
  await dialog.getByLabel('选择成员 预览校验下级').check();
  for (const [locale, catalog] of [['en', en], ['vi', vi], ['hi', hi]] as const) {
    await page.locator('.language-switcher select').selectOption(locale);
    await expect(dialog).toHaveAttribute('aria-label', catalog['批量调整直属下级价格']);
    await expect(dialog.getByLabel(catalog['新的统一折扣'])).toHaveValue('0');
    await dialog.getByRole('button', { name: catalog['预览调价结果'] }).click();
    await expect(dialog.locator('.batch-preview')).toContainText('× 0.0000');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/pricing-batch-${locale}-mobile.png`, fullPage: true });
    // Changing the value invalidates the preview while retaining the form across languages.
    await dialog.getByLabel(catalog['新的统一折扣']).fill('0.0000');
    await expect(dialog.locator('.batch-preview')).toHaveCount(0);
    await dialog.getByLabel(catalog['新的统一折扣']).fill('0');
  }
  await page.locator('.language-switcher select').selectOption('zh-CN');
  await dialog.getByRole('button', { name: '预览调价结果' }).click();
  await dialog.getByRole('button', { name: '确认批量调价' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.team-members-panel')).toContainText('待生效 × 0.0000');
  await expect(page.locator('.team-members-panel')).toContainText('× 0.2000');
});
