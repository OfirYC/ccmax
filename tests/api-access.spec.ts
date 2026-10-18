import { test, expect } from './fixtures';
import en from '../src/locales/en.json' with { type: 'json' };
import vi from '../src/locales/vi.json' with { type: 'json' };
import hi from '../src/locales/hi.json' with { type: 'json' };

test('an agent creates scoped API keys, integrates independently, and revokes access', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByLabel(en['登录邮箱']).fill('agent@example.com');
  await page.getByLabel(en['密码'], { exact: true }).fill('e2e-agent-password');
  await page.getByRole('button', { name: en['进入工作空间'] }).click();
  await page.locator('.nav-item[href="/settings"]').click();
  const section = page.locator('.api-access');
  await expect(section.getByRole('heading', { name: 'API access' })).toBeVisible();
  await expect(section.getByLabel(en['API 基础地址'])).toHaveValue('http://127.0.0.1:4319');
  await section.getByRole('button', { name: en['创建 API 密钥'] }).click();
  const create = page.getByRole('dialog', { name: en['创建 API 密钥'], exact: true });
  await create.getByLabel(en['密钥名称']).fill('Read-only integration');
  await expect(create.getByLabel(en['读取团队数据'])).toBeChecked();
  await expect(create.getByLabel(en['读取团队数据'])).toBeDisabled();
  await expect(create.getByLabel(en['操作账单与提现'])).not.toBeChecked();
  await create.getByLabel(en['当前密码']).fill('e2e-agent-password');
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/settings/api-keys') && response.request().method() === 'POST');
  await create.getByRole('button', { name: en['生成密钥'] }).click();
  const created = await (await createdResponse).json();
  const issued = page.getByRole('dialog', { name: en['保存你的 API 密钥'] });
  const token = await issued.getByRole('textbox', { name: en['API 密钥'], exact: true }).inputValue();
  expect(token).toMatch(/^ccmax_sk_[\w-]{43}$/);
  await issued.getByRole('button', { name: en['我已保存'] }).click();

  // The separate request fixture has no website login session or CSRF header.
  const accounts = await request.get('/api/accounts', { headers: { authorization: `Bearer ${token}` } });
  expect(accounts.status()).toBe(200);
  expect((await accounts.json()).accounts.map((account: any) => account.email)).toContain('claude-fixture@example.com');
  const forbidden = await request.post('/api/accounts', { headers: { authorization: `Bearer ${token}` }, data: { email: 'no-scope@example.com' } });
  expect(forbidden.status()).toBe(403); expect((await forbidden.json()).code).toBe('INSUFFICIENT_SCOPE');
  await page.reload();
  await expect(section).toContainText('Read-only integration');
  expect(await page.locator('body').textContent()).not.toContain(token);
  const listing = await page.request.get('/api/settings/api-keys');
  expect(await listing.text()).not.toContain(token);
  expect(await listing.text()).not.toContain('token_hash');

  await section.getByRole('button', { name: en['创建 API 密钥'] }).click();
  await create.getByLabel(en['密钥名称']).fill('Account integration');
  await create.getByLabel(en['管理账号、代理与上号']).check();
  await create.getByLabel(en['有效期']).selectOption('30');
  await create.getByLabel(en['当前密码']).fill('e2e-agent-password');
  await create.getByRole('button', { name: en['生成密钥'] }).click();
  const writeToken = await issued.getByRole('textbox', { name: en['API 密钥'], exact: true }).inputValue();
  await issued.getByRole('button', { name: en['我已保存'] }).click();
  const write = await request.post('/api/accounts', { headers: { authorization: `Bearer ${writeToken}` }, data: { email: 'api-browser@example.com', label: 'API integration' } });
  expect(write.status()).toBe(200);
  expect((await write.json()).account.email).toBe('api-browser@example.com');

  const popup = page.waitForEvent('popup');
  await section.getByRole('link', { name: en['接入文档'] }).click();
  const guide = await popup;
  await expect(guide.getByRole('heading', { name: 'CCMAX Agent API', exact: true })).toBeVisible();
  await expect(guide.locator('body')).toContainText('/api/accounts/:id/authorize');
  await guide.close();
  const spec = await (await request.get('/api/openapi.json')).json();
  expect(spec.openapi).toBe('3.1.0');
  expect(spec.paths['/api/accounts'].post['x-required-scope']).toBe('accounts:write');
  for (const [locale, catalog] of [['vi', vi], ['hi', hi], ['en', en]] as const) {
    await page.locator('.language-switcher select').selectOption(locale);
    await expect(section.getByRole('heading', { name: catalog['API 接入'], exact: true })).toBeVisible();
    await expect(section).toContainText(catalog['管理账号、代理与上号']);
  }
  await page.screenshot({ path: 'test-results/api-access-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/api-access-mobile.png', fullPage: true });
  const row = section.getByRole('row').filter({ hasText: 'Read-only integration' });
  await row.getByRole('button', { name: en['撤销'], exact: true }).click();
  await page.getByRole('dialog', { name: en['撤销 API 密钥'] }).getByRole('button', { name: en['确认撤销'] }).click();
  await expect(row).toContainText(en['已撤销']);
  expect((await request.get('/api/accounts', { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  expect((await request.get('/api/accounts', { headers: { authorization: `Bearer ${writeToken}` } })).status()).toBe(200);
  expect((await page.request.get('/api/settings/api-keys')).ok()).toBe(true);
  expect(created.key.id).toBeTruthy();
  expect(errors).toEqual([]);
});

test('saved Chinese is preserved and blocked browser storage falls back to English', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  await page.goto('/');
  await expect(page.getByLabel('登录邮箱')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  const blocked = await context.browser()!.newContext();
  await blocked.addInitScript(() => { Storage.prototype.getItem = () => { throw new DOMException('blocked'); }; });
  const freshPage = await blocked.newPage();
  await freshPage.goto('http://127.0.0.1:4319/');
  await expect(freshPage.getByLabel(en['登录邮箱'])).toBeVisible();
  await expect(freshPage.locator('html')).toHaveAttribute('lang', 'en');
  await blocked.close();
});
