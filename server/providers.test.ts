import { describe,it,expect } from 'vitest';
import { ProviderClient, UpstreamError } from './providers.js';

const account=(id:string)=>({id,email:`${id}@example.com`,stats:{daily_cost:'1.25'},status:'active',outbound_proxy_id:'fixed-proxy'});
const fixedProxy={proxy:'http://user:pass@proxy.example.com:8080',proxyExternalId:'fixed-proxy'};
const client=(handler:(url:string,init?:RequestInit)=>any)=>new ProviderClient('ai008',{username:'test',password:'test'},async(url,init)=>Response.json(await handler(String(url),init)));

describe('upstream adapter data integrity',()=>{
  const history=(handler:(page:number)=>any)=>client((url,init)=>init?.method==='POST'?{task:{id:'history'}}:handler(Number(new URL(url).searchParams.get('account_page'))));
  const historyPage=(page:number,accounts:any[],count=accounts.length,size=100)=>({task:{id:'history',status:'succeeded',input:{since:'2026-10-17T00:00:00+08:00',until:'2026-10-17T23:59:59+08:00'}},result:{accounts,account_page:page,account_count:count,page_size:size}});
  it('reads every AI008 history page and preserves decimal amounts without shared-total allocation',async()=>{
    const pages:number[]=[];
    const rows=await history(page=>{pages.push(page);return historyPage(page,[{account_id:String(page),cost:page===1?'9007199254740993.12345678':'0.00000001'}],2,1);}).historicalDay('2026-10-17');
    expect(pages).toEqual([1,2]);expect(rows).toEqual([{externalId:'1',rawUsd:'9007199254740993.12345678'},{externalId:'2',rawUsd:'0.00000001'}]);
    expect(await history(()=>historyPage(1,[],0,0)).historicalDay('2026-10-17')).toEqual([]);
  });
  it.each([null,undefined,'NaN','Infinity','secret-invalid-value',-1,'10000000000000000'])('rejects invalid historical account amounts (%s) before producing import candidates',async cost=>{
    await expect(history(()=>historyPage(1,[{account_id:'one',cost}])).historicalDay('2026-10-17')).rejects.toThrow('历史用量');
  });
  it('rejects repeated account IDs across history pages, missing counts and inconsistent query pages',async()=>{
    for(const response of [
      (page:number)=>historyPage(page,[{account_id:'same',cost:1}],2,1),
      ()=>({task:{id:'history',status:'succeeded'},result:{accounts:[]}}),
      (page:number)=>historyPage(page,[{account_id:String(page),cost:1}],page===1?2:3,1),
      ()=>historyPage(1,[{account_id:'one',cost:1}],2,1),
      ()=>({...historyPage(1,[{account_id:'one',cost:1}]),task:{id:'other-query',status:'succeeded'}}),
      ()=>({...historyPage(1,[{account_id:'one',cost:1}]),task:{id:'history',status:'succeeded',input:{since:'2026-10-16T00:00:00Z'}}}),
      ()=>historyPage(1,[{account_id:'one',cost:1}],NaN,1),
    ])await expect(history(response).historicalDay('2026-10-17')).rejects.toThrow('历史');
  });
  it('follows all declared pages even when the upstream ignores our requested page size',async()=>{
    const pages:number[]=[];
    const c=client(url=>{const page=Number(new URL(url).searchParams.get('page'));pages.push(page);return {accounts:[account(String(page))],pagination:{page,page_size:1,total_pages:3,total_rows:3}};});
    const accounts=await c.listAccounts();expect(pages).toEqual([1,2,3]);expect(accounts).toHaveLength(3);
  });
  it('does not turn an absent upstream usage amount into a zero-dollar snapshot',()=>{
    const c=client(()=>({}));expect(()=>c.normalize({id:'one',email:'one@example.com',stats:{}})).toThrow('有效的当日用量');
  });
  it('saves snapshot pages independently, isolates invalid accounts and retries a failed page without replaying earlier pages',async()=>{
    const calls:number[]=[],saved:string[]=[];let retry=true,saveRetry=true;
    const c=new ProviderClient('ai008',{username:'fixture',password:'fixture'},async url=>{
      const page=Number(new URL(String(url)).searchParams.get('page'));calls.push(page);
      if(page===2&&retry){retry=false;return new Response('',{status:503});}
      return Response.json({accounts:page===1?[account('first'),{...account('bad'),stats:{daily_cost:-1}},account('retry')]:[account('last')],pagination:{total_pages:2,total_rows:4}});
    });
    const result=await c.captureSnapshots(async row=>{
      if(row.id==='retry'&&saveRetry){saveRetry=false;throw new Error('temporary database error');}
      saved.push(row.id);
    });
    expect(calls).toEqual([1,2,2]);expect(saved.sort()).toEqual(['first','last','retry']);
    expect(result).toEqual({accounts:3,issueCount:1});
  });
  it('preserves already captured accounts if a later snapshot page is denied',async()=>{
    const saved:string[]=[];
    const c=new ProviderClient('ai008',{username:'fixture',password:'fixture'},async url=>Number(new URL(String(url)).searchParams.get('page'))===1
      ?Response.json({accounts:[account('kept')],pagination:{total_pages:2,total_rows:2}}):new Response('',{status:403}));
    await expect(c.captureSnapshots(async row=>{saved.push(row.id);})).rejects.toMatchObject({upstreamStatus:403});
    expect(saved).toEqual(['kept']);
  });
  it('tries the actual Gatelink history permission and requires an exact daily account breakdown',async()=>{
    const day='2026-10-17',query={from:day,to:day,scopeUserId:'49'},item={date:day,dataStatus:'complete',accounts:[{account_id:'a',cost:'1.23456789'}],usageUsdExact:'1.23456789'};
    const gate=(body:any,status=200)=>{
      const c=new ProviderClient('gatelink',{username:'fixture',password:'fixture'},async url=>{
        const u=new URL(String(url));expect(u.pathname).toBe('/api/admin/usage-settlements');
        expect(u.searchParams.get('source')).toBe('upstream');expect(u.searchParams.get('scopeUserId')).toBe('49');
        return Response.json(body,{status});
      });c.user={id:'49',role:'agent'};return c;
    };
    await expect(gate({},403).historicalDay(day)).rejects.toBeInstanceOf(UpstreamError);
    expect(await gate({query,statsSource:'upstream',items:[item]}).historicalDay(day)).toEqual([{externalId:'a',rawUsd:'1.23456789'}]);
    for(const body of [
      {query:{...query,from:'2026-10-16'},statsSource:'upstream',items:[item]},
      {query,statsSource:'local',items:[item]},
      {query,statsSource:'upstream',items:[{...item,accounts:undefined}]},
      {query,statsSource:'upstream',items:[{...item,usageUsdExact:'2'}]},
      {query,statsSource:'upstream',items:[{...item,dataStatus:'pending'}]},
    ])await expect(gate(body).historicalDay(day)).rejects.toThrow();
  });
  it('keeps a new Gatelink account with a null counter without blocking valid inventory or inventing usage',async()=>{
    const rows=[{id:'new',submittedEmail:'new@example.com',upstreamDailyCost:null},{id:'valid',submittedEmail:'valid@example.com',upstreamDailyCost:'1.25'}];
    const c=new ProviderClient('gatelink',{username:'fixture',password:'fixture'},async()=>Response.json({items:rows,total:2,totalPages:1}));
    const accounts=await c.listAccounts();expect(accounts).toHaveLength(2);
    expect(accounts[0].dailyUsd).toBeNull();expect(accounts[0].telemetry?.periods.today.billedUsd).toBeNull();expect(accounts[1].dailyUsd).toBe('1.25');
    expect(()=>c.normalize({...rows[0],upstreamDailyCost:-1})).toThrow('有效的当日用量');
    expect(()=>c.normalize({...rows[0],upstreamDailyCost:'private-invalid'})).toThrow('有效的当日用量');
  });
  it('rejects overlapping, truncated, changing or unidentified pages for both shared master adapters',async()=>{
    for(const provider of ['ai008','gatelink'] as const) {
      const row=(n:string)=>provider==='ai008'?account(n):{id:n,submittedEmail:`${n}@example.com`,upstreamDailyCost:'1.25'};
      const page=(rows:any[],total:number,pages=1)=>provider==='ai008'?{accounts:rows,pagination:{total_rows:total,total_pages:pages}}:{items:rows,total,totalPages:pages};
      for(const [responses,error] of [
        [[page([row('1')],2)],'结果不完整'],
        [[page([row('1')],2,2),page([row('1')],2,2)],'重复账号'],
        [[page([row('1')],2,2),page([row('2')],3,2)],'账号数在分页时发生变化'],
        [[page([{id:'missing',stats:{daily_cost:0},upstreamDailyCost:0}],1)],'可核实邮箱'],
      ] as const) {
        let n=0;const c=new ProviderClient(provider,{username:'fixture',password:'fixture'},async()=>Response.json(responses[n++]));
        await expect(c.listAccounts()).rejects.toThrow(error);
      }
    }
  });
  it('verifies a token import against the authoritative account list when the response contains only an ID',async()=>{
    const c=client(url=>url.endsWith('/import-rt')?{id:'real'}:url.endsWith('/real')?{account:{outbound_proxy_id:'fixed-proxy'}}:{accounts:[account('real')],pagination:{total_pages:1}});
    const remote=await c.importRefreshToken({email:'claimed@example.com',...fixedProxy},'owned-refresh-token');
    expect(remote.email).toBe('real@example.com');
  });
  it('fails closed if a write has no authoritative identity to verify',async()=>{
    const c=client(url=>url.endsWith('/import-rt')?{id:'missing'}:url.endsWith('/missing')?{account:{outbound_proxy_id:'fixed-proxy'}}:{accounts:[],pagination:{total_pages:1}});
    await expect(c.importRefreshToken({email:'claimed@example.com',...fixedProxy},'owned-refresh-token')).rejects.toThrow('可验证的真实邮箱');
  });
  it('checks OAuth state before sending a one-use code upstream',async()=>{
    let calls=0;const c=client(()=>{calls++;return {};});
    await expect(c.exchangeOAuth({options:{email:'a@example.com',...fixedProxy},pendingState:'expected'},'https://callback.example/?code=once&state=wrong')).rejects.toThrow('state');expect(calls).toBe(0);
  });
  it.each(['once#expected','https://callback.example/?code=once&state=expected'])('preserves AI008 code#state for %s',async callback=>{
    const requests:string[]=[];
    const c=client((url,init)=>{
      const path=new URL(url).pathname;requests.push(path);
      if(path.endsWith('/auth-url'))return {url:'https://auth.example/?state=expected',state:'expected'};
      if(path.endsWith('/exchange')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({code:'once#expected',pending_state:'expected',outbound_proxy_id:'fixed-proxy'});
        return {id:'real'};
      }
      expect(path).toBe('/api/admin/oauth-accounts/real');
      return {account:{canonical_identity:{email:'real@example.com'},outbound_proxy_id:'fixed-proxy'}};
    });
    const attempt=await c.startOAuth({email:'real@example.com',...fixedProxy});
    expect((await c.exchangeOAuth(attempt.secret,callback)).email).toBe('real@example.com');
    expect(requests).toHaveLength(3);
  });
  it.each(['once','once#','#expected','https://callback.example/?code=once','https://callback.example/?code=once&state=expected&state=other','https://[invalid/?code=once&state=expected'])('rejects incomplete or ambiguous AI008 callbacks before any network request: %s',async callback=>{
    let calls=0;const c=client(()=>{calls++;return {};});
    await expect(c.exchangeOAuth({options:{email:'real@example.com',...fixedProxy},pendingState:'expected'},callback)).rejects.toThrow('完整回调');
    expect(calls).toBe(0);
  });
  it('does not leak upstream response bodies through errors',async()=>{
    const c=new ProviderClient('ai008',{username:'test',password:'test'},async()=>new Response('token=private-secret',{status:403}));
    await expect(c.call('/api/admin/oauth-accounts')).rejects.toThrow('HTTP 403');
    try{await c.call('/api/admin/oauth-accounts');}catch(error){expect(String(error)).not.toContain('private-secret');}
  });
  it('blocks Gatelink account status writes with an agent session and permits an authenticated upstream admin',async()=>{
    let writes=0;
    const c=new ProviderClient('gatelink',{username:'fixture',password:'fixture'},async(url,init)=>{writes++;expect(String(url)).toContain('/api/admin/accounts/existing/enabled');expect(JSON.parse(String(init?.body))).toEqual({enabled:false});return Response.json({});});
    c.user={role:'agent'};await expect(c.setEnabled('existing',false)).rejects.toThrow('上游管理员权限');expect(writes).toBe(0);
    c.user={role:'admin'};await c.setEnabled('existing',false);expect(writes).toBe(1);
  });
});
