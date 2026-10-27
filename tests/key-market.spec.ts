import { test, expect } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  await page.goto('/');
  await page.getByLabel('登录邮箱').fill('owner@example.com');
  await page.getByLabel('密码', { exact: true }).fill('e2e-owner-password');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.locator('.workspace-switch')).toBeVisible();
});

test('keeps a failed connection visible, repairs its credentials, and retries gateway loading before creating a task', async ({ page }) => {
  // Exercise browser recovery without submitting fixture credentials to a live supplier.
  const connectionId = '82b70ffd-e160-4ecb-b81b-37cb280407e2';
  let connection: Record<string, unknown> | null = null;
  let editPayload: Record<string, unknown> = {};
  let taskPayload: Record<string, unknown> = {};
  let gatewayAttempts = 0;
  await page.route('**/api/new-api-connections', async route => {
    if (route.request().method() === 'POST') {
      connection = { id: connectionId, name: 'KeyMan browser fixture', base_url: 'https://kapi.example.com/admin-api', adapter_type: 'keyman_newapi', auth_type: 'password', tenant_id: '1', quota_per_unit: '500000', status: 'error', last_error: 'KeyMan：验证码不能为空' };
      await route.fulfill({ json: { connection, verified: false, warning: connection.last_error } });
    } else await route.fulfill({ json: { connections: connection ? [connection] : [] } });
  });
  await page.route(`**/api/new-api-connections/${connectionId}`, async route => {
    editPayload = route.request().postDataJSON();
    connection = { ...connection, status: 'connected', auth_type: 'access_token', last_error: null, last_sync_at: new Date().toISOString() };
    await route.fulfill({ json: { connection, verified: true } });
  });
  await page.route(`**/api/new-api-connections/${connectionId}/gateways`, async route => {
    gatewayAttempts++;
    if (gatewayAttempts === 1) await route.fulfill({ status: 502, json: { error: '网关临时不可用，请重试' } });
    else await route.fulfill({ json: { gateways: [{ id: '7', name: '供货网关' }] } });
  });
  await page.route('**/api/key-tasks', async route => {
    if (route.request().method() === 'POST') {
      taskPayload = route.request().postDataJSON();
      await route.fulfill({ json: { task: { id: 'browser-task', ...taskPayload } } });
    } else await route.fulfill({ json: { tasks: [] } });
  });

  await page.goto('/key/settings');
  await page.getByRole('button', { name: '新增连接', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务模板').selectOption('keyman_newapi');
  await dialog.getByLabel('连接名称').fill('KeyMan browser fixture');
  await dialog.getByLabel('管理 API 地址').fill('https://kapi.example.com/admin-api');
  await dialog.getByLabel('quota_per_unit').fill('500000');
  await dialog.getByLabel('管理员账号', { exact: true }).fill('fixture');
  await dialog.getByLabel('管理员密码', { exact: true }).fill('fixture-password');
  await dialog.getByRole('button', { name: '验证并保存' }).click();
  const card = page.locator('.connection-card');
  await expect(card).toContainText('KeyMan browser fixture');
  await expect(card).toContainText('验证码不能为空');
  await expect(page.getByText('还没有平台连接', { exact: true })).toHaveCount(0);

  await page.goto('/key/tasks');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('平台 / 任务模板').locator(`option[value="${connectionId}"]`)).toHaveAttribute('disabled', '');
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeDisabled();
  await dialog.getByRole('link', { name: '配置并验证平台连接' }).click();
  await card.getByRole('button', { name: '编辑并验证' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('连接名称')).toHaveValue('KeyMan browser fixture');
  await expect(dialog.getByLabel('管理员密码', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: '管理访问令牌', exact: true }).click();
  await dialog.getByLabel('管理访问令牌', { exact: true }).fill('browser-access-token-fixture');
  await dialog.getByRole('button', { name: '验证并保存' }).click();
  await expect(card).toContainText('已连接');
  expect(editPayload).toMatchObject({ authType: 'access_token', accessToken: 'browser-access-token-fixture' });
  expect(editPayload).not.toHaveProperty('password');
  await card.getByRole('link', { name: '前往创建任务' }).click();
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('平台 / 任务模板').selectOption(connectionId);
  await expect(dialog.getByRole('alert')).toContainText('网关临时不可用');
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '重新加载网关' }).click();
  await expect(dialog.getByLabel('KeyMan 网关')).toHaveValue('7');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByLabel('任务名称').fill('浏览器供货任务');
  await dialog.getByLabel('模型（可换行或逗号分隔）').fill('gpt-4o');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(taskPayload).toMatchObject({ connectionId, templateType: 'keyman_newapi', gatewayId: '7', models: ['gpt-4o'] });
});

test('shows connection fetch errors without claiming that no connections exist', async ({ page }) => {
  await page.route('**/api/new-api-connections', route => route.fulfill({ status: 503, json: { error: '连接列表暂时不可用' } }));
  await page.goto('/key/settings');
  await expect(page.getByRole('alert')).toContainText('连接列表暂时不可用');
  await expect(page.getByText('还没有平台连接', { exact: true })).toHaveCount(0);
});
