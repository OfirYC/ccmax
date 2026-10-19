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
  await page.getByRole('button',{name:'成员汇总',exact:true}).click();await expect(page.getByText('成员汇总仅计算该成员本人名下账号；下级用量列在各自成员行。全部成员行之和等于当前范围总计，不重复累加团队。',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/telemetry-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
});

test('dashboard and account amounts match attributed activity, and prior-day details never appear as today',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.getByRole('heading',{name:'你好，测试代理',exact:true})).toBeVisible();
  const dashboard=await (await page.request.get('/api/dashboard')).json(),activity=await (await page.request.get('/api/telemetry')).json(),accounts=await (await page.request.get('/api/accounts')).json();
  for(const p of activity.platforms){expect(dashboard.platforms.find((v:any)=>v.id===p.id).daily_usd).toBe(p.billedUsd.value);}
  expect(accounts.accounts.find((a:any)=>a.email==='claude-fixture@example.com').bindings.reduce((n:number,b:any)=>n+Number(b.today_usd),0)).toBe(Number(activity.totals.billedUsd.value));
  await expect(page.locator('.platform-overview')).toHaveCount(3);await expect(page.locator('.platform-overview').filter({hasText:'Mini CC Gateway'}).locator('.amount').first()).toHaveText('—');
  await page.route('**/api/telemetry?**',async route=>{
    const response=await route.fetch(),data=await response.json();
    for(const row of data.rows)row.telemetry.day='2000-01-01';
    await route.fulfill({response,json:data});
  });
  await page.locator('.nav-item[href="/analytics"]').click();await expect(page.locator('.telemetry-table tbody tr')).toHaveCount(2);
  await page.getByRole('button',{name:'调用详情',exact:true}).first().click();const today=page.getByRole('dialog').getByRole('row').filter({has:page.getByRole('cell',{name:'今日',exact:false})});
  await expect(today).toContainText('今日有效数据暂缺');await expect(today).not.toContainText('$100');
  await expect(today.locator('td').nth(1)).toHaveText('—');await expect(today.locator('td').nth(2)).toHaveText('—');
});

test('a delayed older refresh cannot overwrite the newer account snapshot',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await page.locator('.nav-item[href="/accounts"]').click();await expect(page.getByRole('article',{name:'claude-fixture@example.com',exact:true})).toHaveCount(1);
  let release:()=>void=()=>{},started:()=>void=()=>{},n=0;const held=new Promise<void>(r=>release=r),requested=new Promise<void>(r=>started=r);
  await page.route('**/api/accounts',async route=>{
    const sequence=++n,response=await route.fetch(),data=await response.json();
    data.accounts[0].label=sequence===1?'older-response':'newer-response';
    if(sequence===1){started();await held;}
    await route.fulfill({response,json:data});
  });
  await page.getByRole('button',{name:'刷新账号',exact:true}).click();await requested;
  await page.getByRole('button',{name:'刷新账号',exact:true}).click();await expect(page.locator('.pool-card-grid')).toContainText('newer-response');
  const late=page.waitForResponse(r=>r.url().endsWith('/api/accounts'));release();await (await late).finished();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('.pool-card-grid')).toContainText('newer-response');await expect(page.locator('.pool-card-grid')).not.toContainText('older-response');
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

test('owner sees unassigned AI008 usage and a dated model cache without assigning earnings',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.route('**/api/dashboard',async route=>{
    const response=await route.fetch(),data=await response.json(),ai=data.platforms.find((p:any)=>p.provider==='ai008');
    Object.assign(ai,{account_count:9,daily_usd:'0',daily_covered:9,seven_day_usd:'18245.658334',seven_day_covered:9,attribution:{assigned:0,unassigned:9}});
    await route.fulfill({response,json:data});
  });
  await page.route('**/api/telemetry?**',async route=>{
    const response=await route.fetch(),data=await response.json(),q=new URL(route.request().url());
    if((q.searchParams.get('scope')??'team')==='team'){
      data.attribution={assigned:0,unassigned:data.total};
      for(const r of data.rows){r.ownership_verified=false;r.owner_id=null;r.owner_name=null;}
      if((q.searchParams.get('period')??'today')==='today'){data.totals.requests.value='0';data.totals.billedUsd.value='0';}
      for(const m of data.totals.models){Object.assign(m,{value:null,covered:0,reference:{value:m.model==='opus'?'17987.630294':'75.710322',covered:data.total,total:data.total,oldestAt:'2026-10-18T17:09:45Z',newestAt:'2026-10-18T17:09:45Z'}});}
    }
    await route.fulfill({response,json:data});
  });
  await page.goto('/');await page.getByLabel('登录邮箱').fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-owner-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  const card=page.locator('.platform-overview').filter({has:page.locator('.platform-mark.ai008')});
  await expect(card).toContainText('待归属 9 个');await expect(card.locator('.platform-week')).toContainText('$18,245.66');
  await page.setViewportSize({width:390,height:844});await card.screenshot({path:'test-results/owner-ai008-platform-mobile.png'});
  await card.click();await expect(page).toHaveURL(/connectionId=.*period=7d/);
  await expect(page.getByRole('button',{name:'全平台账号',exact:true})).toBeVisible();await expect(page.locator('.telemetry-attribution')).toContainText('待归属平台账号：1');
  await expect(page.locator('.telemetry-models')).toContainText('$17,987.6303');await expect(page.locator('.telemetry-models')).toContainText('非实时');await expect(page.locator('.telemetry-models')).toContainText('模型缓存时间');
  await page.getByRole('button',{name:'今日',exact:true}).click();await expect(page.locator('.telemetry-zero')).toContainText('今日请求和消费均为 0');
  await page.getByRole('link',{name:'查看近 7 天用量',exact:true}).click();await expect(page).toHaveURL(/period=7d/);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/owner-ai008-status-mobile.png',fullPage:true});
  await page.locator('.telemetry-models').screenshot({path:'test-results/owner-ai008-model-cache-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'仅本人',exact:true}).click();await expect(page.locator('.telemetry-attribution')).toHaveCount(0);
});
