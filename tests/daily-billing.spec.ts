import { test, expect } from './fixtures';

test('an administrator sees snapshot estimates, collection issues and schedules a retry from the daily archive',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');
  await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.getByRole('heading',{name:'你好，平台管理员',exact:true})).toBeVisible();
  const connections=await(await page.request.get('/api/connections')).json(),c=connections.connections.find((r:any)=>r.provider==='gatelink');
  const day=new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
  // Presentation fixtures exercise an estimated result and a partial failure;
  // no upstream requests, new invoices or wallet entries are made by this test.
  await page.route('**/api/billing/days?**',route=>route.fulfill({json:{rows:[{
    connection_id:c.id,provider:c.provider,connection_name:'private-upstream-snapshot@example.com',day,basis:'snapshot',state:'needs_attention',statement_id:'snapshot-fixture',
    attempts:2,account_count:5,finalized_count:4,issue_count:1,raw_usd:'123.45678901',last_attempt_at:day+'T18:00:00Z',
    error:null,issues:[{externalId:'missing-snapshot',message:'日终快照缺失或距离零点超过 10 分钟，等待核对'}],
  }],total:1,page:1}}));
  await page.getByRole('link',{name:'用量明细',exact:true}).click();
  const panel=page.locator('.daily-billing-panel');await expect(panel.getByRole('heading',{name:'每日自动账单库',exact:true})).toBeVisible();
  await expect(panel).not.toContainText('private-upstream-');await expect(panel.getByText('快照预估',{exact:true})).toBeVisible();await expect(panel).toContainText('4 / 5');
  await expect(panel.getByRole('link',{name:'原始日账单'})).toHaveAttribute('href','/api/billing/statements/snapshot-fixture');
  await panel.getByRole('button',{name:'详情',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'每日账单采集详情'});
  await expect(dialog).toContainText('本账单包含日终快照预估');await expect(dialog).toContainText('missing-snapshot');
  await expect(dialog).toContainText('日终快照缺失');await page.getByRole('button',{name:'关闭弹窗'}).click();
  await page.screenshot({path:'test-results/daily-billing-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(panel.getByText('快照预估',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/daily-billing-mobile.png',fullPage:true});
  await page.route('**/api/billing/collect',async route=>{
    expect(route.request().postDataJSON()).toEqual({connectionIds:[c.id],from:day,to:day});await route.fulfill({json:{jobs:[{id:'fixture',state:'queued'}]}});
  });
  await panel.getByRole('button',{name:'补采历史账单',exact:true}).click();const collect=page.getByRole('dialog',{name:'补采历史账单'});
  await collect.getByLabel('平台连接').selectOption(c.id);await collect.getByLabel('开始日期').fill(day);await collect.getByLabel('结束日期').fill(day);
  await collect.getByRole('button',{name:'开始自动采集',exact:true}).click();await expect(collect).toHaveCount(0);
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('link',{name:'平台管理',exact:true}).click();await page.locator('.connection-card').filter({has:page.locator('.platform-mark.gatelink')}).getByRole('button',{name:'配置连接',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('23:55 至次日 00:10 每分钟采集');
  await page.getByRole('button',{name:'关闭弹窗'}).click();await page.getByRole('button',{name:'添加连接',exact:true}).click();
  const settings=page.getByRole('dialog'),snapshotToggle=settings.getByRole('checkbox',{name:'历史接口不可用时，允许按日终快照预估自动出账'});
  await expect(snapshotToggle).toBeChecked();await settings.getByLabel('平台',{exact:true}).selectOption('ai008');await expect(snapshotToggle).not.toBeChecked();
  await settings.getByLabel('平台',{exact:true}).selectOption('gatelink');await expect(snapshotToggle).toBeChecked();
  expect(errors).toEqual([]);
});

test('agents see the estimate label on their automatic invoice without access to the admin archive',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.getByRole('heading',{name:'你好，测试代理',exact:true})).toBeVisible();
  const finance=await(await page.request.get('/api/finance')).json();
  await page.route('**/api/finance?**',route=>route.fulfill({json:{...finance,invoices:[{id:'estimate',number:'CC-SNAPSHOT',date_from:'2026-10-17',date_to:'2026-10-17',gross_usd:'30',downstream_usd:'20',profit_usd:'10',state:'pending',automatic:true,estimated:true}],invoicesTotal:1}}));
  await page.getByRole('link',{name:'账单结算',exact:true}).click();
  await expect(page.getByRole('row').filter({hasText:'CC-SNAPSHOT'})).toContainText('快照预估');
  await page.getByRole('link',{name:'用量明细',exact:true}).click();await expect(page.getByRole('heading',{name:'每日自动账单库',exact:true})).toHaveCount(0);
  expect((await page.request.get('/api/billing/days')).status()).toBe(403);
});
