import { test,expect } from '@playwright/test';

test('owner and agent complete team, usage, settlement and withdrawal flows',async({page})=>{
 test.setTimeout(90000);
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(/Content Security Policy|violates the following/i.test(message.text()))errors.push(message.text());});
 await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');await page.getByRole('button',{name:'进入工作空间'}).click();
 await expect(page.getByRole('heading',{name:'你好，平台管理员'})).toBeVisible();
 await page.getByRole('link',{name:'代理团队',exact:true}).click();await expect(page.getByText('测试下级',{exact:true})).toBeVisible();await expect(page.getByRole('columnheader',{name:'团队平台账单'})).toBeVisible();
 await page.getByRole('button',{name:'创建直属下级'}).click();
 await page.getByLabel('成员名称').fill('浏览器代理');await page.getByLabel('登录邮箱').fill('browser@example.com');await page.getByLabel('初始登录密码').fill('browser-password');await page.getByLabel('Gatelink 结算折扣').fill('0.2');await page.getByLabel('AI008 结算折扣').fill('0.1');await page.getByLabel('Mini CC Gateway 结算折扣').fill('0.15');await page.getByRole('button',{name:'创建下级账号',exact:true}).click();await expect(page.getByText('浏览器代理',{exact:true})).toBeVisible();
 await page.getByRole('columnheader',{name:'Mini CC Gateway 折扣'}).waitFor();
 await page.getByRole('link',{name:'平台连接',exact:true}).click();await expect(page.getByRole('heading',{name:'Mini CC Test'})).toBeVisible();
 await page.getByRole('button',{name:'添加连接',exact:true}).click();await page.getByLabel('平台',{exact:true}).selectOption('minicc');await expect(page.getByLabel('平台',{exact:true})).toHaveValue('minicc');await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('link',{name:'用量明细',exact:true}).click();await page.getByLabel('开始日期').fill('1970-01-01');await expect(page.locator('tbody tr')).toHaveCount(2);await expect(page.locator('.usage-totals')).toContainText('$200.00');
 await page.getByRole('link',{name:'账单结算',exact:true}).click();await page.getByRole('button',{name:'生成结算账单',exact:true}).click();await page.getByRole('button',{name:'生成账单',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1);
 await page.getByRole('button',{name:'确认上游回款',exact:true}).click();await page.getByLabel('回款凭证 / 结算确认说明').fill('browser verified upstream receipt');await page.getByRole('button',{name:'确认并记入利润账本',exact:true}).click();await expect(page.locator('tbody')).toContainText('已确认');
 await page.getByRole('link',{name:'利润提现',exact:true}).click();await page.getByRole('button',{name:'提取平台利润',exact:true}).click();await page.getByLabel('提现金额（USD）').fill('10');await page.getByLabel('收款信息').fill('test-only-destination');await page.getByRole('button',{name:'创建利润提取记录',exact:true}).click();await expect(page.locator('tbody').first()).toContainText('test-only-destination');
 await page.getByRole('button',{name:'记录已提取',exact:true}).click();await page.getByLabel('付款凭证 / 交易流水号').fill('manual-transfer-reference');await page.getByRole('button',{name:'确认已打款',exact:true}).click();await expect(page.locator('tbody').first()).toContainText('已打款');
 await page.locator('.user-card').click();await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
 await page.getByRole('link',{name:'代理团队',exact:true}).click();await expect(page.getByText('测试下级',{exact:true})).toBeVisible();await expect(page.getByText('浏览器代理',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'创建直属下级'}).click();await page.getByLabel('成员名称').fill('代理的下级');await page.getByLabel('登录邮箱').fill('nested@example.com');await page.getByLabel('初始登录密码').fill('nested-password');await page.getByLabel('Gatelink 结算折扣').fill('0.1');await page.getByLabel('AI008 结算折扣').fill('0.1');await page.getByLabel('Mini CC Gateway 结算折扣').fill('0.15');await page.getByRole('button',{name:'创建下级账号',exact:true}).click();await expect(page.getByText('代理的下级',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'账号管理',exact:false}).first().click();await expect(page.getByText('claude-fixture@example.com',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'设置与审计',exact:true}).click();await expect(page.getByRole('heading',{name:'设置与审计',exact:true})).toBeVisible();await page.getByRole('link',{name:'账号管理',exact:false}).first().click();
 await page.screenshot({path:'test-results/workspace-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'账号管理',exact:true})).toBeVisible();await page.screenshot({path:'test-results/workspace-mobile.png',fullPage:true});
 expect(errors).toEqual([]);
});

test('Mini CC is selectable for onboarding, token import and historical reconciliation',async({page})=>{
 await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');await page.getByRole('button',{name:'进入工作空间'}).click();
 // Only the platform options are mocked. Never send fixture credentials to a live upstream.
 await page.route('**/api/connections/*/options',route=>route.fulfill({json:{configurationLocked:true,proxyMode:'manual',requireProxy:true,policies:[{id:'default-policy',name:'Default policy'}],groups:[{id:'team',name:'Default group'}],templates:[{id:'default-cc',name:'Default CC'}],defaults:{policyTemplateId:'default-policy',groupIds:['team'],ccTemplateId:'default-cc'}}}));
 await page.getByRole('link',{name:'账号管理',exact:false}).first().click();
 await page.getByRole('button',{name:'新增账号 / 多平台上号',exact:true}).click();
 await page.getByLabel('Claude 账号邮箱').fill('mini-e2e@example.com');await page.getByRole('button',{name:'下一步：选择平台'}).click();
 await page.locator('.target-card').filter({hasText:'Mini CC Test'}).getByRole('checkbox').check();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByLabel('账号策略')).toHaveValue('default-policy');await expect(dialog.getByLabel('账号策略')).toBeDisabled();
 await expect(dialog.getByLabel('分组',{exact:true})).toBeDisabled();await expect(dialog.getByLabel('CC 模板',{exact:true})).toHaveValue('default-cc');
 await expect(dialog.getByRole('button',{name:'一键生成所选平台授权链接'})).toBeDisabled();
 await dialog.getByRole('button',{name:'添加新代理',exact:true}).click();
 await dialog.getByLabel('代理名称',{exact:true}).fill('Mini account fixed proxy');await dialog.getByLabel('代理地址',{exact:true}).fill('http://ui-user:ui-private-password@proxy.example.com:8080');
 await dialog.getByRole('button',{name:'添加并绑定代理',exact:true}).click();
 await expect(dialog.getByText('固定出口代理：Mini account fixed proxy',{exact:true})).toBeVisible();
 await expect(dialog.getByRole('button',{name:'一键生成所选平台授权链接'})).toBeEnabled();
 await dialog.getByRole('button',{name:'Refresh token 导入',exact:true}).click();
 await dialog.getByLabel('目标平台',{exact:true}).selectOption({label:'Mini CC Test'});await expect(dialog.getByLabel('账号策略')).toHaveValue('default-policy');
 await dialog.getByRole('button',{name:'关闭弹窗'}).click();
 await page.getByRole('link',{name:'用量明细',exact:true}).click();await page.getByRole('button',{name:'读取历史账单'}).click();
 await page.getByLabel('支持历史查询的平台连接').selectOption({label:'Mini CC Test'});await expect(page.getByLabel('支持历史查询的平台连接')).not.toHaveValue('');
 await page.getByRole('button',{name:'关闭弹窗'}).click();await page.getByRole('link',{name:'出口代理',exact:true}).click();await expect(page.locator('tbody')).toContainText('mini-e2e@example.com');await expect(page.locator('tbody')).toContainText('http://proxy.example.com:8080');await expect(page.locator('tbody')).not.toContainText('ui-private-password');
 await page.screenshot({path:'test-results/proxies-desktop.png',fullPage:true});
});
