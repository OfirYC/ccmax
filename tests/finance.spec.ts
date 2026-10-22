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
  await expect(page.getByRole('button',{name:en['全平台资金核对'],exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an owner reconciles every wallet and platform without changing invoices or withdrawals',async({page})=>{
  await page.goto('/');
  await page.getByLabel(en['登录邮箱']).fill('owner@example.com');await page.getByLabel(en['密码'],{exact:true}).fill('e2e-owner-password');
  await page.getByRole('button',{name:en['进入工作空间']}).click();await page.getByRole('link',{name:en['账单结算'],exact:true}).click();
  const before=await(await page.request.get('/api/finance')).json();
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/finance/audit');
  await page.getByRole('button',{name:en['全平台资金核对'],exact:true}).click();
  const report=await(await response).json();expect(report.ok).toBe(true);expect(report.platforms).toHaveLength(3);expect(report.checked.finalizedUsageDays).toBeGreaterThanOrEqual(2);
  const dialog=page.getByRole('dialog');await expect(dialog.getByText(en['账目一致性核对通过'],{exact:true})).toBeVisible();
  await expect(dialog.getByRole('heading',{name:en['各代理资金余额'],exact:true})).toBeVisible();
  await expect(dialog.getByRole('row').filter({hasText:en['平台 C']})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await dialog.locator('.finance-audit-totals').screenshot({path:'test-results/finance-audit-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:en['关闭弹窗']}).click();
  const after=await(await page.request.get('/api/finance')).json();
  expect({balance:after.balance,invoices:after.invoices,withdrawals:after.withdrawals,ledger:after.ledger}).toEqual({balance:before.balance,invoices:before.invoices,withdrawals:before.withdrawals,ledger:before.ledger});
});

test('automatic bills are visible without a manual creation or preview step',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');
  await page.getByRole('button',{name:'进入工作空间'}).click();await page.getByRole('link',{name:'账单结算',exact:true}).click();
  await expect(page.getByText('每天北京时间 02:00 后自动更新昨日账单。',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'生成结算账单',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'预览结算账单',exact:true})).toHaveCount(0);
  const before=await(await page.request.get('/api/finance')).json();
  expect(before.invoices.every((invoice:any)=>invoice.automatic)).toBe(true);
  await page.getByRole('button',{name:'我的账单',exact:true}).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);await expect(page.locator('tbody')).toContainText('$110.0000');
  await page.getByRole('button',{name:'直属下级账单',exact:true}).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);await expect(page.locator('tbody')).toContainText('$60.0000');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/automatic-invoice-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const after=await(await page.request.get('/api/finance')).json();
  expect({balance:after.balance,invoices:after.invoices,ledger:after.ledger}).toEqual({balance:before.balance,invoices:before.invoices,ledger:before.ledger});
});
