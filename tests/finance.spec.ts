import { test, expect } from './fixtures';
import en from '../src/locales/en.json' with { type: 'json' };

test('shows exact eight-decimal amounts and reconciles the real wallet from the finance page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel(en['登录邮箱']).fill('agent@example.com');
  await page.getByLabel(en['密码'], { exact: true }).fill('e2e-agent-password');
  await page.getByRole('button', { name: en['进入工作空间'] }).click();
  // Only the presentation response is mocked to exercise the full storage
  // precision. The reconciliation request below uses the real empty wallet.
  const financeUrl = (url: URL) => url.pathname === '/api/finance';
  await page.route(financeUrl, route => route.fulfill({ json: {
    balance: { available: '9999999999999999.99999999', pending: '0.00000000' }, pendingProfit: '0',
    invoices: [], withdrawals: [], ledger: [], invoicesTotal: 0, withdrawalsTotal: 0,
  } }));
  await page.getByRole('link', { name: en['利润提现'], exact: true }).click();
  await page.getByRole('button', { name: en['申请提现'], exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.confirm-amount .amount')).toHaveText('$9,999,999,999,999,999.99999999');
  await page.screenshot({ path: 'test-results/finance-precision-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('.confirm-amount .amount')).toBeVisible();
  await page.screenshot({ path: 'test-results/finance-precision-mobile.png', fullPage: true });
  await page.getByRole('button', { name: en['关闭弹窗'] }).click();
  await page.unroute(financeUrl);
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/finance/check');
  await page.getByRole('button', { name: en['核对资金账本'], exact: true }).click();
  const response = await checked;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, balance: { available: '0.00000000', pending: '0.00000000' } });
  await expect(page.getByText(en['资金账本核对通过，余额和冻结流水一致'], { exact: true })).toBeVisible();
  await expect(page.locator('.finance-balance .amount')).toHaveText('$0.00');
  expect(errors).toEqual([]);
});
