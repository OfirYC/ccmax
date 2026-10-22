import { describe,it,expect } from 'vitest';
import { ProviderClient, PROVIDERS } from './providers.js';

const proxy={proxy:'http://user:secret@fixed.proxy.example:8080',proxyExternalId:'fixed-proxy'};
const account={id:'owned-account',email:'owned@example.com',status:'active',outbound_proxy_id:'fixed-proxy',stats:{daily_cost:'12.50',daily_req:20,daily_tok:900,rpm:2,tpm:90}};
function client(handler:(path:string,body:any,init:RequestInit)=>any) {
  return new ProviderClient('maxchat',{username:'private-master@example.com',password:'private-password'},async(input,init={})=>{
    const url=new URL(String(input));expect(url.origin).toBe('https://cldgtw.maxchatapi.com');
    return Response.json(await handler(url.pathname+url.search,init.body?JSON.parse(String(init.body)):{},init));
  });
}

describe('MaxChat Gateway adapter',()=>{
  it('uses an independent bearer session and reads empty supplier inventory and assigned onboarding configuration',async()=>{
    const c=client((path,body,init)=>{
      if(path.endsWith('/admin-login')){expect(body).toEqual({identifier:'private-master@example.com',email:'private-master@example.com',password:'private-password'});return {accessToken:'maxchat-session',user:{role:'vendor',vendor_role:'standard'}};}
      expect(init.headers).toMatchObject({Authorization:'Bearer maxchat-session',Origin:PROVIDERS.maxchat.url});
      if(path.includes('oauth-accounts'))return {accounts:[],pagination:{page:1,page_size:100,total_pages:0,total_rows:0}};
      if(path.endsWith('/groups'))return {items:[{id:'assigned-group',name:'Assigned group',private_secret:'hidden'}]};
      return {items:[{id:'default-template',name:'Default',is_default:true,private_secret:'hidden'}]};
    });
    await expect(c.login()).resolves.toMatchObject({role:'vendor'});
    expect(await c.listAccounts()).toEqual([]);
    const options=await c.options();expect(options).toMatchObject({requireProxy:true,groups:[{id:'assigned-group',name:'Assigned group'}]});
    expect(JSON.stringify(options)).not.toContain('private_secret');
  });

  it('submits its independent OAuth callback with the fixed proxy and verifies canonical identity',async()=>{
    let exchanges=0;
    const c=client((path,body)=>{
      if(path.endsWith('/auth-url')){expect(body).toMatchObject({outbound_proxy_mode:'manual',outbound_proxy_id:'fixed-proxy',group_ids:['group']});return {url:'https://auth.example/?state=maxchat-state',state:'maxchat-state'};}
      if(path.endsWith('/exchange')){exchanges++;expect(body).toMatchObject({code:'maxchat-code#maxchat-state',pending_state:'maxchat-state',outbound_proxy_id:'fixed-proxy'});return {id:account.id};}
      expect(path).toBe('/api/admin/oauth-accounts/'+account.id);return {account};
    });
    const attempt=await c.startOAuth({...proxy,email:account.email,groupIds:['group']});
    expect((await c.exchangeOAuth(attempt.secret,'maxchat-code#maxchat-state')).email).toBe(account.email);expect(exchanges).toBe(1);
  });

  it('imports RT, changes status and reads back the intended account and fixed proxy',async()=>{
    let status='active';
    const c=client((path,body,init)=>{
      if(path.endsWith('/import-rt')){expect(body).toMatchObject({refresh_token:'private-refresh-token',outbound_proxy_id:'fixed-proxy'});return {id:account.id};}
      if(init.method==='PATCH'){status=body.status??status;return {};}
      return {account:{...account,status}};
    });
    expect((await c.importRefreshToken({...proxy,email:account.email},'private-refresh-token')).proxyExternalId).toBe('fixed-proxy');
    await c.verifySubmissionTarget(account.id,account.email);await c.setEnabled(account.id,false);await c.verifyAccountStatus(account.id,account.email,false);
    await c.setAccountProxy(account.id,{...proxy,email:account.email});
  });

  it('keeps RPM, token and model usage attributed to the account and ignores shared master summaries',async()=>{
    const c=client(path=>path.includes('model-usage')?{generated_at:new Date().toISOString(),accounts:{[account.id]:{today:{opus:'5.25',fable:'7.25'}}},summary:{today:{opus:'99999'}}}:path.includes('?page_mode')?{accounts:[account],pagination:{total_pages:1,total_rows:1}}:{account,stats:account.stats});
    const rows=await c.listAccounts();await c.enrichTelemetry(rows);
    expect(rows[0].telemetry?.activity).toMatchObject({rpm:2,tpm:90});
    expect(rows[0].telemetry?.periods.today).toMatchObject({requests:20,tokens:900,billedUsd:'12.5',models:[{model:'opus',usageUsd:'5.25'},{model:'fable',usageUsd:'7.25'}]});
  });

  it('reads all historical account pages for the Beijing day and rejects partial financial data',async()=>{
    let partial=false;
    const c=client((path,body)=>{
      if(path.endsWith('/queries')){expect(body).toMatchObject({since:'2026-10-21T00:00:00+08:00',until:'2026-10-21T23:59:59+08:00'});return {task:{id:'history'}};}
      const page=Number(new URL('https://fixture.example'+path).searchParams.get('account_page'));
      return {task:{id:'history',status:'succeeded'},result:{accounts:partial?[]:[{account_id:'account-'+page,cost:page===1?'12.50':'0.00000001'}],account_count:2,account_page:page,page_size:1}};
    });
    expect(await c.historicalDay('2026-10-21')).toEqual([{externalId:'account-1',rawUsd:'12.5'},{externalId:'account-2',rawUsd:'0.00000001'}]);
    partial=true;await expect(c.historicalDay('2026-10-21')).rejects.toThrow('不完整');
  });
});
