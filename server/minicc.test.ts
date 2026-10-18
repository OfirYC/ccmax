import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderClient } from './providers.js';

const fixedProxy={proxy:'http://user:pass@proxy.example.com:8080',proxyExternalId:'fixed-proxy'};
const meta=()=>({
  groups:[{id:'other',name:'Other'},{id:'team',name:'Team'}],
  policyTemplates:[{id:'custom',name:'Custom'},{id:'default',name:'Default',is_default:true,group_ids:['team','deleted'],policy:{max_rpm:75,max_tpm:80000000,max_concurrent:20,max_sessions:100}}],
  ccTemplates:[{id:'custom-cc',name:'Custom CC'},{id:'default-cc',name:'Default CC',is_default:true}],
  outboundProxies:[{id:'proxy',name:'Private proxy',url:'http://secret-user:secret-pass@proxy.test'}],
});
const account=(n:number)=>({id:`local-${n}`,upstream_id:`upstream-${n}`,email:`claude${n}@example.com`,daily_cost:'2.125',cost_7d:'10',cost_30d:'30',status:'active'});
function client(handler:(path:string,body:any,init:RequestInit)=>any) {
  return new ProviderClient('minicc',{username:'test',password:'test'},async(url,init={})=>{
    const parsed=new URL(String(url));
    const data=await handler(parsed.pathname+parsed.search,init.body?JSON.parse(String(init.body)):null,init);
    return data instanceof Response?data:Response.json(data);
  });
}
afterEach(()=>vi.useRealTimers());

describe('Mini CC Gateway adapter',()=>{
  it('authenticates using a private cookie session and verifies /api/me',async()=>{
    const c=client((path,body,init)=>{
      if(path==='/api/login') {
        expect(body).toEqual({username:'test',password:'test'});
        return Response.json({role:'supplier'},{headers:{'set-cookie':'mini_session=private-session; HttpOnly; Path=/'}});
      }
      expect(path).toBe('/api/me');
      expect((init.headers as Record<string,string>).Cookie).toBe('mini_session=private-session');
      expect((init.headers as Record<string,string>).Authorization).toBeUndefined();
      return {authenticated:true,user:{username:'test',role:'supplier'}};
    });
    expect(await c.login()).toEqual({role:'supplier',username:'test'});
    const restored=client((_path,_body,init)=>{expect((init.headers as Record<string,string>).Cookie).toContain('private-session');return {};});
    restored.restoreSession(c.exportSession());await restored.call('/api/meta');
    await expect(client(()=>({authenticated:false})).login()).rejects.toThrow('有效会话');
  });

  it('uses upstream IDs and top-level costs across every declared page',async()=>{
    const pages:number[]=[];
    const c=client(path=>{const page=Number(new URL('http://test'+path).searchParams.get('page'));pages.push(page);return {accounts:[account(page)],page,pages:3,total:3};});
    const rows=await c.listAccounts();
    expect(pages).toEqual([1,2,3]);expect(rows.map(r=>r.id)).toEqual(['upstream-1','upstream-2','upstream-3']);
    expect(rows[0]).toMatchObject({dailyUsd:'2.125',cost7d:'10',cost30d:'30'});
    expect(()=>c.normalize({...account(1),daily_cost:undefined})).toThrow('有效的当日用量');
    expect(()=>c.normalize({...account(1),daily_cost:-1})).toThrow('有效的当日用量');
    expect(()=>c.normalize({...account(1),upstream_id:undefined})).toThrow('账号 ID');
    expect(()=>c.normalize({...account(1),daily_cost:'private-response-value'})).toThrow('有效的当日用量');
    try { c.normalize({...account(1),daily_cost:'private-response-value'}); }catch(error) {expect(String(error)).not.toContain('private-response-value');}
    await expect(client(()=>({accounts:[account(1)],pages:1,total:2})).listAccounts()).rejects.toThrow('结果不完整');
    await expect(client(()=>({accounts:[account(1),account(1)],pages:1,total:2})).listAccounts()).rejects.toThrow('重复账号');
    await expect(client(()=>({accounts:[{...account(1),email:null}],pages:1,total:1})).listAccounts()).rejects.toThrow('可核实邮箱');
  });

  it('exposes only locked defaults and filters deleted groups and proxy secrets',async()=>{
    const options=await client(()=>meta()).options();
    expect(options).toMatchObject({configurationLocked:true,proxyMode:'manual',requireProxy:true,defaults:{policyTemplateId:'default',ccTemplateId:'default-cc',groupIds:['team']}});
    expect(JSON.stringify(options)).not.toContain('secret-pass');
    expect(JSON.stringify(options)).not.toContain('deleted');
    await expect(client(()=>({...meta(),ccTemplates:[]})).options()).rejects.toThrow('默认策略或 CC 模板');
    await expect(client(()=>({...meta(),groups:[]})).options()).rejects.toThrow('可用分组');
  });

  it('imports RT with upstream defaults and verifies the authoritative detail email',async()=>{
    const c=client((path,body)=>{
      if(path==='/api/meta')return meta();
      if(path==='/api/accounts/import-rt') {
        expect(body).toMatchObject({refresh_token:'owned-token',overwrite_existing:false,outbound_proxy_mode:'manual',outbound_proxy_id:'fixed-proxy',
          policy_template_id:'default',cc_template_id:'default-cc',group_ids:['team'],max_rpm:75,max_tpm:80000000,max_concurrent:20,max_sessions:100});
        expect(body).not.toHaveProperty('account_type');return {id:'real',email:'claimed@example.com'};
      }
      expect(path).toBe('/api/accounts/real/detail');return {account:{email:'owned@example.com',outbound_proxy_id:'fixed-proxy'}};
    });
    const remote=await c.importRefreshToken({email:'claimed@example.com',policyTemplateId:'custom',ccTemplateId:'custom-cc',groupIds:['other'],...fixedProxy},'owned-token');
    expect(remote).toMatchObject({id:'real',email:'owned@example.com'});
  });

  it('refuses ownership when neither detail nor the account list verifies an email',async()=>{
    const c=client(path=>path==='/api/meta'?meta():path.endsWith('import-rt')?{id:'missing',name:'claimed@example.com'}:path.endsWith('/detail')?{account:{name:'claimed@example.com',outbound_proxy_id:'fixed-proxy'}}:{accounts:[],pages:1,total:0});
    await expect(c.importRefreshToken({email:'claimed@example.com',...fixedProxy},'owned-token')).rejects.toThrow('可验证的真实邮箱');
  });

  it('uses Mini CC OAuth endpoints, exact state and code#state without overwriting accounts',async()=>{
    let exchanged=0;
    const c=client((path,body)=>{
      if(path==='/api/meta')return meta();
      if(path==='/api/accounts/auth-url') {expect(body.overwrite_existing).toBe(false);return {url:'https://auth.example/authorize',state:'expected'};}
      if(path==='/api/accounts/exchange'){exchanged++;expect(body.code).toBe('once#expected');expect(body.pending_state).toBe('expected');expect(body.overwrite_existing).toBe(false);return {id:'real'};}
      return {account:{canonical_identity:{email:'real@example.com'},outbound_proxy_id:'fixed-proxy'}};
    });
    const oauth=await c.startOAuth({email:'real@example.com',...fixedProxy});
    await expect(c.exchangeOAuth(oauth.secret,'once#wrong')).rejects.toThrow('state');
    await expect(c.exchangeOAuth(oauth.secret,'once')).rejects.toThrow('完整回调');expect(exchanged).toBe(0);
    expect((await c.exchangeOAuth(oauth.secret,'https://callback.example/?code=once&state=expected')).email).toBe('real@example.com');
  });

  it('writes status changes to the upstream ID endpoint',async()=>{
    const c=client((path,body,init)=>{expect(path).toBe('/api/accounts/upstream-id/status');expect(init.method).toBe('POST');expect(body).toEqual({status:'disabled'});return {};});
    await c.setEnabled('upstream-id',false);
  });

  it('queries one Beijing calendar day and polls until all account usage is complete',async()=>{
    vi.useFakeTimers();let requests=0;
    const c=client(path=>{
      const query=new URL('http://test'+path).searchParams;
      expect(query.get('since')).toBe('2026-10-16T16:00:00.000Z');expect(query.get('until')).toBe('2026-10-17T15:59:59.000Z');
      requests++;
      return requests===1?{complete:false,pending:true,accounts:[{account_id:'real',cost:999}]}:{complete:true,pending:false,refreshing:false,accounts:[{account_id:'real',cost:1.2345}]};
    });
    const result=c.historicalDay('2026-10-17');await vi.runAllTimersAsync();
    expect(await result).toEqual([{externalId:'real',rawUsd:'1.2345'}]);expect(requests).toBe(2);
  });

  it('refuses incomplete history instead of closing a zero or partial bill',async()=>{
    vi.useFakeTimers();
    const result=expect(client(()=>({complete:false,pending:true,accounts:[]})).historicalDay('2026-10-17')).rejects.toThrow('尚未完成');
    await vi.runAllTimersAsync();await result;
    await expect(client(()=>({accounts:[]})).historicalDay('2026-10-17')).rejects.toThrow('完整性标记缺失');
  });

  it('does not invent zero records for absent accounts and rejects invalid or duplicate historical costs',async()=>{
    const history=(accounts:any[])=>client(()=>({complete:true,pending:false,refreshing:false,accounts})).historicalDay('2026-10-17');
    expect(await history([])).toEqual([]);
    await expect(history([{account_id:'a'}])).rejects.toThrow('字段缺失');
    await expect(history([{account_id:'a',cost:-1}])).rejects.toThrow('金额或账号重复');
    await expect(history([{account_id:'a',cost:1},{account_id:'a',cost:1}])).rejects.toThrow('金额或账号重复');
  });
});
