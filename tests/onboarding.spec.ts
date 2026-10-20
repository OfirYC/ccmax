import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';

for (const rejectionStatus of [400, 409]) test(`platform authorizations stay independent and a ${rejectionStatus} on a pending platform preserves its callback`, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  await page.goto('/');
  await page.getByLabel('登录邮箱').fill('owner@example.com');
  await page.getByLabel('密码', { exact: true }).fill('e2e-owner-password');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('h1')).toContainText('你好');
  const headers = { 'x-ccmax-request': '1' };
  const account = (await (await page.request.post('/api/accounts', { headers, data: { email: `independent-oauth-${rejectionStatus}@example.com` } })).json()).account;
  const proxy = await (await page.request.post('/api/proxies', { headers, data: { name: 'Independent OAuth proxy', url: `http://oauth-${rejectionStatus}.proxy.example.com:8080` } })).json();
  expect((await page.request.post(`/api/accounts/${account.id}/proxy`, { headers, data: { proxyId: proxy.id } })).ok()).toBe(true);
  const connections = (await (await page.request.get('/api/connections')).json()).connections.slice(0, 3);
  const attempts = connections.map((connection: any, index: number) => ({
    id: randomUUID(), connection_id: connection.id, connection_name: `OAuth platform ${index + 1}`,
    provider: connection.provider, authorization_url: `https://auth.example.com/?state=platform-${index + 1}`,
    state: 'pending', expires_at: new Date(Date.now() + 600000).toISOString(),
  }));
  const submitted: { id: string; callback: string }[] = [], accepted = new Set<string>();
  await page.route(`**/api/accounts/${account.id}/attempts`, route => route.fulfill({ json: { attempts: attempts.filter((attempt: any) => !accepted.has(attempt.id)) } }));
  await page.route('**/api/oauth/*/exchange', async route => {
    const attemptId = new URL(route.request().url()).pathname.split('/')[3];
    submitted.push({ id: attemptId, callback: route.request().postDataJSON().callback });
    if (attemptId === attempts[1].id) return route.fulfill({ status: rejectionStatus, json: { error: '授权未完成，请重新打开此平台的授权链接' } });
    accepted.add(attemptId);
    return route.fulfill({ json: { id: attemptId, state: 'queued' } });
  });
  await page.route('**/api/jobs', route => route.fulfill({ json: { jobs: [...accepted].map(id => ({ id, kind: 'oauth_exchange', state: 'succeeded', connection_name: 'OAuth platform' })) } }));
  await page.goto('/accounts');
  await page.getByRole('button', { name: '新增账号 / 多平台上号', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '多平台分别授权' });
  await dialog.getByLabel('选择已有 Claude 账号（可选）').selectOption(account.id);
  const cards = dialog.locator('.oauth-attempt');
  await expect(cards).toHaveCount(3);
  await expect(dialog).toContainText('选择 3 个平台就需要分别完成 3 次授权');
  const submit = dialog.getByRole('button', { name: '批量提交各平台独立授权', exact: true });
  // Different states do not make the same one-use code reusable.
  for (let index = 0; index < 3; index++) await cards.nth(index).getByRole('textbox').fill(`duplicate-code#platform-${index + 1}`);
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('同一个授权码不能用于多个平台');
  expect(submitted).toHaveLength(0);
  await cards.nth(0).getByRole('textbox').fill('wrong-platform-code#platform-2');
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('state 不匹配');
  expect(submitted).toHaveLength(0);
  for (let index = 0; index < 3; index++) await cards.nth(index).getByRole('textbox').fill(`own-code-${index + 1}#platform-${index + 1}`);
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText(connections[1].capabilities.name);
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole('textbox')).toHaveValue('own-code-2#platform-2');
  expect(submitted).toEqual(attempts.map((attempt: any, index: number) => ({ id: attempt.id, callback: `own-code-${index + 1}#platform-${index + 1}` })));
  await expect(cards.getByRole('button', { name: `提交 ${connections[1].capabilities.name} 的授权`, exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/oauth-platforms-${rejectionStatus}-mobile.png`, fullPage: true });
});

test('Gatelink refreshes conflicts, discards failed and expired links, and generates a fresh authorization', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  await page.goto('/');
  await page.getByLabel('登录邮箱').fill('owner@example.com');
  await page.getByLabel('密码', { exact: true }).fill('e2e-owner-password');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('h1')).toContainText('你好');
  const headers = { 'x-ccmax-request': '1' };
  const account = (await (await page.request.post('/api/accounts', { headers, data: { email: 'gate-conflict@example.com' } })).json()).account;
  const proxy = await (await page.request.post('/api/proxies', { headers, data: { name: 'Gatelink conflict proxy', url: 'http://gate.proxy.example.com:8080' } })).json();
  expect((await page.request.post(`/api/accounts/${account.id}/proxy`, { headers, data: { proxyId: proxy.id } })).ok()).toBe(true);
  const connection = (await (await page.request.get('/api/connections')).json()).connections.find((c: any) => c.provider === 'gatelink');
  await page.clock.install();
  const makeAttempt = (state: string) => ({ id: randomUUID(), connection_id: connection.id, provider: 'gatelink', authorization_url: `https://auth.example.com/?state=${state}`, state: 'pending', expires_at: new Date(Date.now() + 600000).toISOString() });
  const original = makeAttempt('old-gate'), concurrent = makeAttempt('concurrent-gate');
  let visible = [original], starts = 0, exchanges = 0;
  await page.route(`**/api/accounts/${account.id}/attempts`, route => route.fulfill({ json: { attempts: visible } }));
  await page.route(`**/api/connections/${connection.id}/options`, route => route.fulfill({ json: { defaults: { accountType: 'speed' } } }));
  await page.route('**/api/oauth/*/exchange', route => {
    exchanges++;
    visible = [{ ...original, state: 'needs_attention' }];
    return route.fulfill({ status: 409, json: { error: '此授权已失效，请先核对同步任务，再重新生成链接并使用新的回调' } });
  });
  const jobId = randomUUID();
  await page.route(`**/api/accounts/${account.id}/authorize`, route => {
    starts++;
    if (starts === 1) {
      visible = [concurrent];
      return route.fulfill({ status: 409, json: { error: '已有有效授权流程，请完成回调或等待过期' } });
    }
    visible = [{ ...makeAttempt('fresh-gate'), expires_at: new Date(Date.now() + 1200000).toISOString() }];
    return route.fulfill({ json: { jobs: [{ id: jobId, state: 'queued' }] } });
  });
  await page.route('**/api/jobs', route => route.fulfill({ json: { jobs: [{ id: jobId, connection_id: connection.id, provider: 'gatelink', kind: 'oauth_start', state: 'succeeded' }] } }));
  await page.goto('/accounts');
  await page.getByRole('button', { name: '新增账号 / 多平台上号', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '多平台分别授权' });
  await dialog.getByLabel('选择已有 Claude 账号（可选）').selectOption(account.id);
  const cards = dialog.locator('.oauth-attempt');
  await expect(cards).toHaveCount(1);
  await dialog.locator('.target-card').filter({ hasText: 'Gatelink' }).getByRole('checkbox').check();
  await cards.getByRole('textbox').fill('old-code#old-gate');
  await cards.getByRole('button', { name: '提交 Gatelink 的授权', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('重新生成链接');
  await expect(cards).toHaveCount(0);
  const generate = dialog.getByRole('button', { name: '批量生成独立授权链接', exact: true });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole('link')).toHaveAttribute('href', concurrent.authorization_url);
  await expect(cards.getByRole('textbox')).toHaveValue('');
  await page.clock.fastForward(600100);
  await expect(cards).toHaveCount(0);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole('link')).toHaveAttribute('href', 'https://auth.example.com/?state=fresh-gate');
  await expect(cards.getByRole('textbox')).toHaveValue('');
  expect(starts).toBe(2);expect(exchanges).toBe(1);
});
