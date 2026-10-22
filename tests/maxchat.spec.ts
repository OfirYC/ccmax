import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';

test('MaxChat connection requires its own price and offers private, proxy-bound OAuth and RT onboarding', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ccmax.locale', 'zh-CN'));
  const connectionId=randomUUID();let connection:any,submitted:any;
  // Mock upstream-facing operations; all account/proxy ownership uses the test DB.
  await page.route('**/api/connections',async route=>{
    if(route.request().method()==='POST') {
      submitted=route.request().postDataJSON();
      connection={id:connectionId,provider:'D',name:'private-D-master@example.com',enabled:true,status:'connected',settlement_rate:submitted.payoutRate,settlement_effective_date:submitted.effectiveFrom,capabilities:{url:'https://cldgtw.maxchatapi.com',refreshTokenImport:true}};
      return route.fulfill({json:{id:connectionId}});
    }
    const response=await route.fetch(),data=await response.json();
    if(connection)data.connections.push(connection);
    await route.fulfill({response,json:data});
  });
  await page.route(`**/api/connections/${connectionId}/options`,route=>route.fulfill({json:{requireProxy:true,policies:[{id:'policy',name:'Policy'}],groups:[{id:'group',name:'Group'}],templates:[{id:'template',name:'Template'}]}}));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await page.locator('.nav-item[href="/platforms"]').click();
  await page.getByRole('button',{name:'添加连接',exact:true}).click();
  const config=page.getByRole('dialog',{name:'添加平台连接'});
  await config.getByLabel('平台',{exact:true}).selectOption('D');
  await config.getByLabel('登录账号',{exact:true}).fill('private-D-master@example.com');await config.getByLabel('登录密码',{exact:true}).fill('fixture-only-password');
  await config.getByRole('button',{name:'保存并连接',exact:true}).click();expect(submitted).toBeUndefined();
  await config.getByLabel('上游给你的结算折扣',{exact:true}).fill('0.45');await config.getByRole('button',{name:'保存并连接',exact:true}).click();
  await expect(config).toHaveCount(0);expect(submitted).toMatchObject({provider:'D',name:'平台 D',payoutRate:0.45,snapshotBilling:false});
  const card=page.getByRole('region',{name:'平台 D',exact:true});
  await expect(card.locator('.settlement-price>strong')).toHaveText('× 0.4500');await expect(card).not.toContainText('private-D-master');
  await card.getByRole('link',{name:'上号到此平台',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'指定平台上号'});
  await dialog.getByLabel('Claude 账号邮箱').fill('D-onboarding@example.com');await dialog.getByRole('button',{name:'下一步：选择平台',exact:true}).click();
  await expect(dialog.locator('.target-card strong')).toHaveText('平台 D');await expect(dialog.locator('.target-price .rate-value')).toHaveText('× 0.4500');
  const authorize=dialog.getByRole('button',{name:'生成此平台授权链接',exact:true});await expect(authorize).toBeDisabled();
  await dialog.getByRole('button',{name:'添加新代理',exact:true}).click();await dialog.getByLabel('代理名称',{exact:true}).fill('MaxChat fixed proxy');await dialog.getByLabel('代理地址',{exact:true}).fill('http://fixture:private@D.proxy.example:8080');await dialog.getByRole('button',{name:'添加并绑定代理',exact:true}).click();await expect(authorize).toBeEnabled();
  let authorization:any;await page.route('**/api/accounts/*/authorize',route=>{authorization=route.request().postDataJSON();return route.fulfill({json:{jobs:[]}});});
  await authorize.click();await expect.poll(()=>authorization?.targets?.length).toBe(1);expect(authorization.targets[0].connectionId).toBe(connectionId);expect(authorization.targets[0].options).not.toHaveProperty('proxy');
  await dialog.getByRole('button',{name:'Refresh token 导入',exact:true}).click();await dialog.getByLabel('目标平台',{exact:true}).selectOption(connectionId);
  await expect(dialog.getByLabel('目标平台').locator('option')).toHaveCount(2);await expect(dialog.getByLabel('账号策略')).toHaveValue('policy');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/D-onboarding-mobile.png',fullPage:true});
  await dialog.getByRole('button',{name:'关闭弹窗'}).click();await page.goto('/analytics');await page.getByLabel('筛选平台',{exact:true}).selectOption('D');await expect(page).toHaveURL(/provider=D/);
  await page.unrouteAll({behavior:'ignoreErrors'});
});
