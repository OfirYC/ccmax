import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

test('0.2 → 0.1 hierarchy caps browser forms and rejects direct API writes above 0.1', async ({ page }) => {
  const password = 'pricing-browser-password';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  async function login(page: Page, email: string, secret: string) {
    await page.getByLabel('登录邮箱').fill(email);
    await page.getByLabel('密码', { exact: true }).fill(secret);
    await page.getByRole('button', { name: '进入工作空间' }).click();
    await expect(page.locator('.user-card')).toBeVisible();
  }
  await page.goto('/');
  await login(page, 'owner@example.com', 'e2e-owner-password');
  const headers = { 'x-ccmax-request': '1' };
  const a = await page.request.post('/api/team', { headers, data: {
    name: '上限测试 A', email: 'ceiling-a@example.com', password, rates: { ai008: 0.2 },
  } });
  expect(a.status()).toBe(200);
  await page.locator('.user-card').click();
  await login(page, 'ceiling-a@example.com', password);
  const b = await page.request.post('/api/team', { headers, data: {
    name: '上限测试 B', email: 'ceiling-b@example.com', password, rates: { ai008: 0.1 },
  } });
  expect(b.status()).toBe(200);
  await page.locator('.user-card').click();
  await login(page, 'ceiling-b@example.com', password);
  await page.getByRole('link', { name: '代理团队', exact: true }).click();
  await page.getByRole('button', { name: '创建直属下级' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('成员名称').fill('硬上限下级');
  await dialog.getByLabel('登录邮箱').fill('ceiling-child@example.com');
  await dialog.getByLabel('初始登录密码').fill(password);
  const rate = dialog.getByLabel('AI008 结算折扣', { exact: true });
  await expect(rate).toHaveAttribute('max', '0.1');
  await expect(dialog.getByText('下级折扣上限：0.1000（含已安排的调价）', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Gatelink 结算折扣', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Mini CC Gateway 结算折扣', { exact: true })).toHaveCount(0);
  const creates: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/team') creates.push(request.postData() || '');
  });
  await rate.fill('0.1001');
  await dialog.getByRole('button', { name: '创建下级账号', exact: true }).click();
  expect(await rate.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow)).toBe(true);
  expect(creates).toHaveLength(0);
  const overCap = await page.request.post('/api/team', { headers, data: {
    name: '拒绝超价', email: 'ceiling-rejected@example.com', password, rates: { ai008: 0.1001 },
  } });
  expect(overCap.status()).toBe(400);
  expect((await overCap.json()).code).toBe('RATE_CAP_EXCEEDED');
  await rate.fill('0.1');
  await page.screenshot({ path: 'test-results/pricing-ceiling-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rate).toBeVisible();
  await page.screenshot({ path: 'test-results/pricing-ceiling-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: '创建下级账号', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(creates).toHaveLength(1);
  expect(JSON.parse(creates[0]).rates).toEqual({ ai008: 0.1 });
  const team = await (await page.request.get('/api/team')).json();
  const child = team.users.find((user: any) => user.email === 'ceiling-child@example.com');
  expect(child).toBeTruthy();
  expect(team.pricing.limits.ai008).toEqual({ create: '0.1000', change: '0.1000' });
  const update = await page.request.put(`/api/team/${child.id}/rates`, { headers, data: { provider: 'ai008', rate: 0.2 } });
  expect(update.status()).toBe(400);
  expect((await update.json()).code).toBe('RATE_CAP_EXCEEDED');
  await page.getByRole('row').filter({ hasText: '硬上限下级' }).getByRole('button', { name: '定价', exact: true }).click();
  await expect(dialog.getByLabel('AI008 结算折扣', { exact: true })).toHaveAttribute('max', '0.1');
  expect(errors).toEqual([]);
});
