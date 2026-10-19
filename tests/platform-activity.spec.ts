import { test,expect } from './fixtures';
import en from '../src/locales/en.json' with {type:'json'};
import vi from '../src/locales/vi.json' with {type:'json'};
import hi from '../src/locales/hi.json' with {type:'json'};

test('platform data cards show scoped usage, unavailable samples, genuine zero, prices and mobile translations',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await page.locator('.nav-item[href="/platforms"]').click();
  const ai=page.getByRole('region',{name:'AI008',exact:true}),gate=page.getByRole('region',{name:'Gatelink',exact:true}),mini=page.getByRole('region',{name:'Mini CC Gateway',exact:true});
  await expect(page.locator('.connection-card')).toHaveCount(3);await expect(ai.locator('.platform-bill-now .amount')).toHaveText('$100.00');
  await expect(ai.locator('.platform-bill-periods')).toContainText('$600.00');await expect(ai.locator('.platform-data-rates')).toContainText('1,200');
  await expect(ai.locator('.platform-data-models')).toContainText('$80.00');await expect(ai.locator('.platform-data-models')).toContainText('$20.00');
  await expect(ai.locator('.settlement-price>strong')).toHaveText('× 0.3000');await expect(mini.locator('.platform-bill-now .amount')).toHaveText('—');
  await expect(mini).toContainText('当前统计范围内暂无平台账号');await expect(page.locator('.platform-activity-overview')).toContainText('$200.00');
  await expect(page.getByRole('button',{name:'配置连接',exact:true})).toHaveCount(0);await expect(page.locator('body')).not.toContainText('private-upstream-');
  await page.getByRole('button',{name:'仅本人',exact:true}).click();await expect(page.getByText('当前统计范围内暂无平台账号',{exact:true})).toHaveCount(3);await expect(ai.locator('.platform-bill-now .amount')).toHaveText('—');
  await page.getByRole('button',{name:'仅下级团队',exact:true}).click();await expect(ai.locator('.platform-bill-now .amount')).toHaveText('$100.00');
  await ai.getByRole('link',{name:'调用详情',exact:true}).click();await expect(page).toHaveURL(/connectionId=.*scope=descendants/);await expect(page.locator('.telemetry-table tbody tr')).toHaveCount(1);
  await page.locator('.nav-item[href="/platforms"]').click();await expect(ai.locator('.platform-bill-now .amount')).toHaveText('$100.00');
  await gate.locator('.platform-capabilities summary').click();await expect(gate).toContainText('需要上游管理员权限');await gate.locator('.platform-capabilities summary').click();
  await page.setViewportSize({width:1512,height:1050});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/platform-data-desktop.png',fullPage:true});

  let zero=false;
  await page.route('**/api/telemetry/platforms?*',async route=>{
    const response=await route.fetch(),data=await response.json(),platform=data.platforms.find((p:any)=>p.provider==='gatelink');
    for(const period of Object.values(platform.periods) as any[]){
      period.fresh=zero?1:0;
      for(const key of ['billedUsd','rpm','tpm','concurrent','requests','tokens']){period[key].value=zero?'0':null;period[key].covered=zero?1:0;}
      for(const model of period.models){model.value=zero?'0':null;model.covered=zero?1:0;}
    }
    platform.newestSourceAt=zero?new Date().toISOString():'2026-01-01T00:00:00Z';
    await route.fulfill({response,json:data});
  });
  await page.getByRole('button',{name:'刷新展示',exact:true}).click();await expect(gate.locator('.platform-bill-now .amount')).toHaveText('—');await expect(gate).toContainText('部分数据已过期或尚未采集');
  zero=true;await page.getByRole('button',{name:'刷新展示',exact:true}).click();await expect(gate.locator('.platform-bill-now .amount')).toHaveText('$0.00');await expect(gate.locator('.platform-data-rates')).toContainText('0');
  await page.unroute('**/api/telemetry/platforms?*');await page.getByRole('button',{name:'刷新展示',exact:true}).click();await expect(gate.locator('.platform-bill-now .amount')).toHaveText('$100.00');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/platform-data-zh-mobile.png',fullPage:true});
  for(const [locale,catalog] of [['en',en],['vi',vi],['hi',hi]] as const){
    await page.locator('.language-switcher select').selectOption(locale);await expect(page.getByRole('heading',{name:catalog['平台管理'],exact:true})).toBeVisible();
    await expect(page.locator('.platform-data-grid')).not.toContainText(/[\u3400-\u9fff]/u);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/platform-data-${locale}-mobile.png`,fullPage:true});
  }
  expect(errors).toEqual([]);
});
