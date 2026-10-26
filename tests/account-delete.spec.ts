import { randomUUID } from 'node:crypto';
import { test,expect } from './fixtures';

test('can delete an owned account that is still awaiting authorization',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ccmax.locale','zh-CN'));
  await page.goto('/');
  await page.getByLabel('登录邮箱').fill('agent@example.com');
  await page.getByLabel('密码',{exact:true}).fill('e2e-agent-password');
  await page.getByRole('button',{name:'进入工作空间'}).click();
  await expect(page.locator('.user-card strong')).toHaveText('测试代理');
  const email='delete-'+randomUUID()+'@example.com';
  const created=await page.request.post('/api/accounts',{headers:{'x-ccmax-request':'1'},data:{email,label:'Delete me'}});
  expect(created.ok()).toBe(true);
  await page.goto('/accounts');
  const card=page.getByRole('article',{name:email,exact:true});
  await expect(card).toBeVisible();
  await card.getByRole('button',{name:'删除账号',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'删除账号',exact:true});
  await expect(dialog).toContainText(email);
  const request=page.waitForRequest(request=>request.method()==='DELETE'&&request.url().includes('/api/accounts/'));
  await dialog.getByRole('button',{name:'确认删除',exact:true}).click();
  expect((await request).postData()).toBeNull();
  await expect(page.getByRole('article',{name:email,exact:true})).toHaveCount(0);
});
