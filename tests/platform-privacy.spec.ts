import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';

test('all platform surfaces ignore private account labels and display personal or frozen prices',async({page})=>{
  test.setTimeout(60000);
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  // Simulate legacy responses containing private labels. Components must use
  // the public provider identity even if a response contains an unsafe name.
  for(const path of ['connections','dashboard','accounts','telemetry?*','usage?*'])await page.route(`**/api/${path}`,async route=>{
    const response=await route.fetch(),data=await response.json();
    if(Array.isArray(data.connections))for(const connection of data.connections){connection.name='private-upstream-connection@example.com';connection.capabilities.name='private-upstream-capability@example.com';}
    if(Array.isArray(data.platforms))for(const platform of data.platforms){platform.name='private-upstream-platform@example.com';platform.connection_name='private-upstream-platform@example.com';}
    if(Array.isArray(data.accounts))for(const account of data.accounts)for(const binding of account.bindings)binding.connection_name='private-upstream-binding@example.com';
    if(Array.isArray(data.rows))for(const row of data.rows)row.connection_name='private-upstream-row@example.com';
    await route.fulfill({response,json:data});
  });
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.getByRole('heading',{name:'你好，平台管理员'})).toBeVisible();
  const connections=(await(await page.request.get('/api/connections')).json()).connections;
    const ai=connections.find((connection:any)=>connection.provider==='ai008'),account=(await(await page.request.get('/api/accounts')).json()).accounts.find((account:any)=>account.email==='claude-fixture@example.com');
  await page.route('**/api/jobs',route=>route.fulfill({json:{jobs:[{id:randomUUID(),connection_id:ai.id,provider:'ai008',connection_name:'private-upstream-job@example.com',kind:'sync',state:'succeeded',created_at:new Date().toISOString(),result:{accounts:1}}]}}));
  await page.route('**/api/proxies',route=>route.fulfill({json:{proxies:[{id:randomUUID(),owner_name:'Fixture',account_email:account.email,name:'Fixture proxy',endpoint:'http://fixture.proxy.example:8080',enabled:true,mappings:[{connection_id:ai.id,provider:'ai008',connection_name:'private-upstream-proxy@example.com',external_id:'fixed-proxy'}]}]}}));
  async function identity(locator:any,rate:string){await expect(locator).toContainText('AI008');await expect(locator.locator('.rate-value')).toHaveText(`× ${rate}`);}
  await identity(page.locator('.platform-overview').filter({has:page.getByRole('heading',{name:'AI008',exact:true})}),'0.6000');
  for(const path of ['/accounts','/analytics','/jobs']){
    await page.goto(path);await expect(page.locator('.platform-identity').filter({hasText:'AI008'}).first()).toBeVisible();
    await identity(page.locator('.platform-identity').filter({hasText:'AI008'}).first(),'0.6000');await expect(page.locator('body')).not.toContainText('private-upstream-');
    if(path==='/accounts'){
      await page.screenshot({path:'test-results/platform-names-accounts-desktop.png',fullPage:true});
      await page.getByRole('row').filter({hasText:account.email}).getByRole('button',{name:'平台管理',exact:true}).click();
      await expect(page.getByRole('dialog',{name:'平台账号管理'})).not.toContainText('private-upstream-');await page.getByRole('button',{name:'关闭弹窗'}).click();
    }
    if(path==='/jobs'){
      await page.getByRole('button',{name:'详情',exact:true}).click();await identity(page.getByRole('dialog').locator('.platform-identity'),'0.6000');await expect(page.getByRole('dialog')).not.toContainText('private-upstream-');await page.getByRole('button',{name:'关闭弹窗'}).click();
    }
  }
  await page.goto('/proxies');await expect(page.locator('tbody')).toContainText('Fixture proxy');await expect(page.locator('body')).not.toContainText('private-upstream-');await expect(page.getByRole('columnheader',{name:'平台映射',exact:true})).toHaveCount(0);
  await page.goto('/platforms');const aiCard=page.locator('.connection-card').filter({has:page.getByRole('heading',{name:'AI008',exact:true})});await expect(aiCard).toBeVisible();await expect(page.locator('body')).not.toContainText('private-upstream-');
  await aiCard.getByRole('button',{name:'配置连接',exact:true}).click();const config=page.getByRole('dialog');await expect(config.getByLabel('连接名称',{exact:true})).toHaveCount(0);await expect(config.locator('input[name=username]')).toHaveValue('');await expect(config.locator('input[name=password]')).toHaveValue('');await expect(config).not.toContainText('private-upstream-');await config.getByRole('button',{name:'关闭弹窗'}).click();
  await page.goto('/usage');await page.getByLabel('开始日期').fill('1970-01-01');await expect(page.locator('tbody tr')).toHaveCount(2);await identity(page.locator('.platform-identity').filter({hasText:'AI008'}),'0.6000');await expect(page.locator('.platform-identity').filter({hasText:'AI008'})).toContainText('账单冻结折扣');
  await expect(page.getByRole('button',{name:'读取历史账单',exact:true})).toHaveCount(0);
  await page.goto('/finance');await expect(page.getByText('每天北京时间 02:00 后自动更新昨日账单。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'生成结算账单',exact:true})).toHaveCount(0);await expect(page.locator('body')).not.toContainText('private-upstream-');
  await page.locator('.user-card').click();await page.getByLabel('登录邮箱').fill('leaf@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();await expect(page.locator('.user-card strong')).toHaveText('测试下级');
  await page.goto('/accounts');await identity(page.getByRole('row').filter({hasText:account.email}).locator('.platform-identity').filter({hasText:'AI008'}).first(),'0.1000');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/platform-names-accounts-mobile.png',fullPage:true});
  const mobilePlatform=page.getByRole('row').filter({hasText:account.email}).locator('.platform-identity').filter({hasText:'AI008'}).first();
  await mobilePlatform.scrollIntoViewIfNeeded();await identity(mobilePlatform,'0.1000');await expect(mobilePlatform).toBeInViewport();
  await page.screenshot({path:'test-results/platform-names-accounts-mobile-platform.png',fullPage:true});
});
