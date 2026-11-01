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

test('an owner previews duplicate removal, explicitly confirms it, and settles only the corrected bill', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  await page.goto('/'); await page.getByLabel('登录邮箱').fill('owner@example.com');
  await page.getByLabel('密码', {exact:true}).fill('e2e-owner-password');
  await page.getByRole('button', {name:'进入工作空间'}).click();
  const original = {id:'duplicate-draft',number:'CC-DUPLICATE',user_name:'平台管理员',user_id:'fixture-owner',payer_id:null,
    date_from:'2026-10-30',date_to:'2026-10-30',gross_usd:'88.00000000',downstream_usd:'12.00000000',profit_usd:'76.00000000',state:'pending',estimated:true};
  // Exercise UI decisions and payloads without changing the shared suite's
  // financial fixtures. Backend tests separately verify the real transaction.
  await expect(page.getByRole('heading', {name:'你好，平台管理员'})).toBeVisible();
  const finance = await (await page.request.get('/api/finance')).json();
  original.user_id = finance.invoices.find((i:any) => !i.payer_id).user_id;
  const replacement = {...original,id:'corrected-draft',number:'CC-CORRECTED',gross_usd:'28.00000000',profit_usd:'16.00000000',estimated:false};
  const previewToken = 'a'.repeat(64);
  let repaired = false, confirmed = false, writes = 0;
  await page.route('**/api/finance?**', route => route.fulfill({json:{...finance,
    invoices:repaired?[{...replacement,state:confirmed?'confirmed':'pending'}, {...original,state:'voided',repair_id:'repair',replacement_number:replacement.number}]:[original],
    invoicesTotal:repaired?2:1}}));
  await page.route('**/api/invoices/duplicate-draft/confirm', route => route.fulfill({status:409,json:{
    code:'REPEATED_SNAPSHOT_CONFLICT',error:'账单包含与前一日完全相同的非零快照，疑似上游缓存；请先核实真实日账单'}}));
  await page.route('**/api/invoices/duplicate-draft/repair-preview', route => route.fulfill({json:{
    invoiceId:original.id,number:original.number,previewToken,
    original:{count:2,gross_usd:'88.00000000',downstream_usd:'12.00000000',profit_usd:'76.00000000'},
    removed:{count:1,gross_usd:'60.00000000',downstream_usd:'0.00000000',profit_usd:'60.00000000'},
    remaining:{count:1,gross_usd:'28.00000000',downstream_usd:'12.00000000',profit_usd:'16.00000000'},
    items:[{usage_id:'duplicate-usage',email:'duplicate@example.com',provider:'A',day:'2026-10-30',previous_day:'2026-10-29',raw_usd:'100.00000000',gross_usd:'60.00000000'}],
  }}));
  await page.route('**/api/invoices/duplicate-draft/repair-duplicates', async route => {
    expect(route.request().postDataJSON()).toEqual({previewToken,reason:'已核对上游账单，删除缓存重复项',acknowledgeDiscard:true});
    writes++; repaired = true; await route.fulfill({json:{invoiceId:original.id,replacement,alreadyRepaired:false}});
  });
  await page.route('**/api/invoices/corrected-draft/confirm', async route => {
    expect(repaired).toBe(true); confirmed = true; await route.fulfill({json:{...replacement,state:'confirmed'}});
  });
  await page.getByRole('link', {name:'账单结算',exact:true}).click();
  await page.getByRole('button', {name:'确认上游回款',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('回款凭证 / 结算确认说明').fill('先检查冲突');
  await dialog.getByRole('button', {name:'确认并记入利润账本'}).click();
  await expect(dialog.getByRole('alert')).toContainText('前一日完全相同');
  await dialog.getByRole('button', {name:'修复账单：移除重复明细',exact:true}).click();
  await expect(dialog.getByText('duplicate@example.com', {exact:true})).toBeVisible();
  await expect(dialog.getByRole('cell', {name:'2026-10-30 2026-10-29'})).toBeVisible();
  await expect(dialog.locator('.confirm-total .amount')).toHaveText('$28.00000000');
  await dialog.getByLabel('修复说明', {exact:true}).fill('已核对上游账单，删除缓存重复项');
  await dialog.getByRole('button', {name:'确认移除重复明细'}).click();
  expect(writes).toBe(0);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/invoice-duplicate-repair-mobile.png',fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByLabel('我已核对，确认移除以上明细及其应收款').check();
  await dialog.getByRole('button', {name:'确认移除重复明细'}).click();
  await expect(dialog).toContainText('CC-CORRECTED');
  await expect(dialog.locator('.confirm-total .amount')).toHaveText('$28.0000');
  expect(writes).toBe(1); expect(confirmed).toBe(false);
  await dialog.getByLabel('回款凭证 / 结算确认说明').fill('正常用量已收到回款');
  await dialog.getByRole('button', {name:'确认并记入利润账本'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText:'CC-CORRECTED'}).first()).toContainText('已确认');
  expect(confirmed).toBe(true);
});

test('automatic duplicate repair requires explicit opt-in and can be disabled', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  let enabled=false,writes=0;
  await page.route('**/api/invoices/repair-policy', async route => {
    if(route.request().method()==='GET')return route.fulfill({json:{enabled}});
    const body=route.request().postDataJSON();
    expect(body.acknowledgeDiscard).toBe(body.enabled);
    enabled=body.enabled;writes++;
    await route.fulfill({json:{policy:{enabled},result:{repaired:enabled?3:0,issues:[]}}});
  });
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');
  await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');
  await page.getByRole('button',{name:'进入工作空间'}).click();
  await page.getByRole('link',{name:'账单结算',exact:true}).click();
  await page.getByRole('button',{name:'启用自动修复',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('相同金额也可能是真实用量');
  await dialog.getByRole('button',{name:'确认开启自动修复'}).click();
  expect(writes).toBe(0);
  await dialog.getByLabel('我同意按以上规则自动移除疑似重复明细及其应收款').check();
  await dialog.getByRole('button',{name:'确认开启自动修复'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('自动修复已开启，本次已修复 3 张账单',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'关闭自动修复',exact:true}).click();
  await expect(page.getByRole('button',{name:'启用自动修复',exact:true})).toBeVisible();
  expect(enabled).toBe(false);expect(writes).toBe(2);
});
