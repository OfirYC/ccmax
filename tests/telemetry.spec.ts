import { test,expect } from './fixtures';
import en from '../src/locales/en.json' with {type:'json'};
import vi from '../src/locales/vi.json' with {type:'json'};
import hi from '../src/locales/hi.json' with {type:'json'};

test('agent views attributed model activity, scopes, periods, details and mobile layout',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await page.locator('.nav-item[href="/analytics"]').click();await expect(page.getByRole('heading',{name:'模型调用',exact:true})).toBeVisible();
  await expect(page.locator('.telemetry-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.telemetry-kpis')).toContainText('240');await expect(page.locator('.telemetry-kpis')).toContainText('84,000');
  await expect(page.locator('body')).not.toContainText('private-upstream-');await expect(page.getByRole('button',{name:'同步平台数据'})).toHaveCount(0);
  await expect(page.locator('.telemetry-trend')).toBeVisible();await page.screenshot({path:'test-results/telemetry-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'仅本人',exact:true}).click();await expect(page.getByText('当前范围没有平台账号',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'仅下级团队',exact:true}).click();await expect(page.locator('.telemetry-table tbody tr')).toHaveCount(2);
  await page.getByLabel('筛选平台').selectOption('ai008');await expect(page.locator('.telemetry-table tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:'近 7 天',exact:true}).click();await expect(page.locator('.telemetry-kpis')).toContainText('720');await expect(page.locator('.telemetry-kpis')).toContainText('$600.0000');
  await page.getByRole('button',{name:'调用详情',exact:true}).click();const dialog=page.getByRole('dialog',{name:'账号调用详情'});
  await expect(dialog).toContainText('144');await expect(dialog).toContainText('96.0%');await expect(dialog).toContainText('缓存补偿 USD');await expect(dialog).toContainText('—');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'平台汇总',exact:true}).click();await expect(page.locator('.telemetry-table tbody')).toContainText('AI008');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/telemetry-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
});

test('model activity switches languages and refreshes snapshots without exposing upstream accounts',async({page})=>{
  await page.goto('/analytics');await page.getByLabel(en['登录邮箱']).fill('agent@example.com');await page.getByLabel(en['密码'],{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:en['进入工作空间']}).click();
  await page.setViewportSize({width:390,height:844});
  for(const [lang,catalog] of [['en',en],['vi',vi],['hi',hi]] as const){
    await page.locator('.language-switcher select').selectOption(lang);
    await expect(page.getByRole('heading',{name:catalog['模型调用'],exact:true})).toBeVisible();
    await page.getByRole('button',{name:catalog['刷新展示'],exact:true}).click();await expect(page.locator('.telemetry-table tbody tr')).toHaveCount(2);
    await expect(page.locator('body')).not.toContainText('private-upstream-');
    await page.getByRole('button',{name:catalog['调用详情'],exact:true}).first().click();await expect(page.getByRole('dialog')).toContainText(catalog['CCMAX 采集时间']);await page.keyboard.press('Escape');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/telemetry-${lang}-mobile.png`,fullPage:true});
  }
});
