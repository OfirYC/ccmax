import { test, expect } from './fixtures';

test('an administrator sees automatic bill updates without collection or import controls',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install();
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');
  await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.getByRole('heading',{name:'你好，平台管理员',exact:true})).toBeVisible();
  const connections=await(await page.request.get('/api/connections')).json(),c=connections.connections.find((r:any)=>r.provider==='gatelink');
  const day=new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
  // Presentation fixtures exercise an estimated result and a partial failure;
  // no upstream requests, new invoices or wallet entries are made by this test.
  const billingWrites:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(billing\/collect|usage\/import|invoices)$/.test(new URL(request.url()).pathname))billingWrites.push(request.url());});
  let updated=false;
  await page.route('**/api/billing/days?**',route=>route.fulfill({json:{rows:[{
    connection_id:c.id,provider:c.provider,connection_name:'private-upstream-snapshot@example.com',day,basis:'snapshot',state:updated?'succeeded':'needs_attention',statement_id:'snapshot-fixture',
    attempts:2,account_count:5,finalized_count:updated?5:4,issue_count:updated?0:1,raw_usd:'123.45678901',last_attempt_at:day+'T18:00:00Z',
    error:null,issues:[{externalId:'missing-snapshot',message:'日终快照缺失或距离零点超过 10 分钟，等待核对'}],
  }],total:1,page:1}}));
  await page.getByRole('link',{name:'用量明细',exact:true}).click();
  const panel=page.locator('.daily-billing-panel');await expect(panel.getByRole('heading',{name:'账单更新记录',exact:true})).toBeVisible();
  await expect(panel).not.toContainText('private-upstream-');await expect(panel.getByText('快照预估',{exact:true})).toBeVisible();await expect(panel).toContainText('4 / 5');
  await expect(panel.getByRole('link',{name:'原始日账单'})).toHaveAttribute('href','/api/billing/statements/snapshot-fixture');
  await panel.getByRole('button',{name:'详情',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'账单详情'});
  await expect(dialog).toContainText('快照预估');await expect(dialog).toContainText('missing-snapshot');
  await expect(dialog).toContainText('日终快照缺失');await page.getByRole('button',{name:'关闭弹窗'}).click();
  await page.screenshot({path:'test-results/daily-billing-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(panel.getByText('快照预估',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/daily-billing-mobile.png',fullPage:true});
  for(const name of ['补采历史账单','读取历史账单','核实日账单','刷新'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  await expect(page.getByText('每天北京时间 02:00 后自动更新昨日账单。',{exact:true})).toBeVisible();
  updated=true;await page.clock.fastForward(10000);await expect(panel).toContainText('5 / 5');
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('link',{name:'平台管理',exact:true}).click();const card=page.locator('.connection-card').filter({has:page.locator('.platform-mark.gatelink')});
  await expect(card).toContainText('每天 02:00 后（北京时间）');await card.getByRole('button',{name:'配置连接',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('checkbox',{name:'历史接口不可用时，允许按日终快照预估自动出账'})).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText('23:55');
  expect(billingWrites).toEqual([]);
  expect(errors).toEqual([]);
});

test('agents see the estimate label on their automatic invoice without access to the admin archive',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.getByRole('heading',{name:'你好，测试代理',exact:true})).toBeVisible();
  const finance=await(await page.request.get('/api/finance')).json();
  await page.route('**/api/finance?**',route=>route.fulfill({json:{...finance,invoices:[{id:'estimate',number:'CC-SNAPSHOT',date_from:'2026-10-17',date_to:'2026-10-17',gross_usd:'30',downstream_usd:'20',profit_usd:'10',state:'pending',automatic:true,estimated:true}],invoicesTotal:1}}));
  await page.getByRole('link',{name:'账单结算',exact:true}).click();
  await expect(page.getByRole('button',{name:'生成结算账单',exact:true})).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText:'CC-SNAPSHOT'})).toContainText('快照预估');
  await page.getByRole('link',{name:'用量明细',exact:true}).click();await expect(page.getByRole('heading',{name:'账单更新记录',exact:true})).toHaveCount(0);await expect(page.getByText('每天北京时间 02:00 后自动更新昨日账单。',{exact:true})).toBeVisible();
  expect((await page.request.get('/api/billing/days')).status()).toBe(403);
});
