import { randomUUID } from 'node:crypto';
import { test,expect } from './fixtures';
import en from '../src/locales/en.json' with {type:'json'};
import vi from '../src/locales/vi.json' with {type:'json'};
import hi from '../src/locales/hi.json' with {type:'json'};

test('account pool cards filter platform usage, retain management, paginate and fit all supported languages',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  let extra=0;
  await page.route('**/api/accounts',async route=>{
    const response=await route.fetch(),data=await response.json(),source=data.accounts.find((a:any)=>a.email==='claude-fixture@example.com'),account=structuredClone(source);
    account.label='MAX 20x · Production';account.owner_name='Team member';account.proxy_id=null;account.proxy_bound=false;account.proxy_name=null;account.proxy_endpoint=null;
    for(const b of account.bindings){
      b.status='active';b.connection_enabled=true;b.data_fresh=true;b.snapshot_at=new Date().toISOString();
      b.telemetry.quota={fiveHour:28,sevenDay:76,reset5h:null,reset7d:null,updatedAt:b.snapshot_at};
      b.telemetry.modelsAt=b.snapshot_at;b.telemetry.day=data.day;
    }
    const cached=structuredClone(account);cached.id=randomUUID();cached.email='cached-account@example.com';cached.label='MAX 5x · Backup';
    cached.bindings=cached.bindings.filter((b:any)=>b.provider==='A');
    for(const b of cached.bindings){b.id=randomUUID();b.data_fresh=false;b.status='error';b.snapshot_at='2026-01-01T00:00:00Z';b.telemetry.periods.today.billedUsd='99999';}
    const pending={...account,id:randomUUID(),email:'pending-account@example.com',label:'Awaiting OAuth',ownership_verified:false,bindings:[]};
    data.accounts=[account,cached,pending,...Array.from({length:extra},(_,n)=>({...pending,id:randomUUID(),email:`pending-${String(n).padStart(2,'0')}@example.com`}))];
    await route.fulfill({response,json:data});
  });
  await page.goto('/');await page.getByLabel('登录邮箱').fill('agent@example.com');await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');await page.getByRole('button',{name:'进入工作空间'}).click();
  await page.locator('.nav-item[href="/accounts"]').click();
  await expect(page.getByRole('article')).toHaveCount(3);
  const account=page.getByRole('article',{name:'claude-fixture@example.com',exact:true});
  await expect(account.locator('.pool-card-bill .amount')).toHaveText('$200.00');await expect(account.locator('.pool-periods')).toContainText('$1,200.00');
  await expect(account.locator('.pool-model-usage')).toContainText('$160.00');await expect(account.locator('.pool-model-usage')).toContainText('$40.00');
  await expect(account.getByRole('meter',{name:'5 小时额度'})).toHaveCount(2);await expect(account.locator('.pool-live')).toContainText('2,400');
  await expect(page.locator('.pool-summary')).toContainText('$200.00');await expect(page.locator('.pool-summary')).not.toContainText('99,999');
  await expect(page.getByRole('article',{name:'cached-account@example.com',exact:true}).locator('.pool-card-bill .amount')).toHaveText('—');
  await expect(page.locator('body')).not.toContainText('private-upstream-');
  await page.setViewportSize({width:1512,height:1050});await page.screenshot({path:'test-results/account-pool-desktop.png',fullPage:true});
  await page.getByLabel('筛选平台').selectOption('B');await expect(page.getByRole('article')).toHaveCount(1);
  await expect(account.locator('.pool-binding')).toHaveCount(1);await expect(account.locator('.pool-card-bill .amount')).toHaveText('$100.00');
  await expect(page.locator('.pool-summary')).toContainText('$100.00');
  await page.getByRole('button',{name:'列表',exact:true}).click();await expect(page.getByRole('row').filter({hasText:'claude-fixture@example.com'})).toContainText('平台 B');
  await page.getByRole('button',{name:'卡片',exact:true}).click();
  await page.getByLabel('筛选平台').selectOption('all');await page.getByLabel('筛选账号状态').selectOption('attention');await expect(page.getByRole('article')).toHaveCount(1);await expect(page.getByRole('article')).toContainText('cached-account@example.com');
  await page.getByLabel('筛选账号状态').selectOption('pending');await expect(page.getByRole('article')).toHaveCount(1);await expect(page.getByRole('article')).toContainText('待授权核实');
  await page.getByLabel('筛选账号状态').selectOption('all');await page.getByLabel('筛选归属').selectOption({label:'仅本人'});await expect(page.getByText('没有匹配的账号',{exact:true})).toBeVisible();
  await page.getByLabel('筛选归属').selectOption('all');await page.getByLabel('搜索账号').fill('claude-fixture');await expect(page.getByRole('article')).toHaveCount(1);await page.getByLabel('搜索账号').fill('');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/account-pool-zh-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const [locale,catalog] of [['en',en],['vi',vi],['hi',hi]] as const){
    await page.locator('.language-switcher select').selectOption(locale);await expect(page.getByRole('heading',{name:catalog['账号管理'],exact:true})).toBeVisible();
    await expect(page.locator('.account-pool')).not.toContainText(/[\u3400-\u9fff]/u);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/account-pool-${locale}-mobile.png`,fullPage:true});
  }
  await page.locator('.language-switcher select').selectOption('zh-CN');
  extra=12;await page.getByRole('button',{name:'刷新账号',exact:true}).click();await expect(page.locator('.pool-viewbar')).toContainText('全部 15 个账号');await expect(page.getByRole('article')).toHaveCount(12);
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('article')).toHaveCount(3);
  await page.getByLabel('每页条数').selectOption('24');await expect(page.getByRole('article')).toHaveCount(15);
  expect(errors).toEqual([]);
});
