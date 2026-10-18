import { describe,it,expect } from 'vitest';
import { ProviderClient } from './providers.js';

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
  it('does not leak upstream response bodies through errors',async()=>{
    const c=new ProviderClient('ai008',{username:'test',password:'test'},async()=>new Response('token=private-secret',{status:403}));
    await expect(c.call('/api/admin/oauth-accounts')).rejects.toThrow('HTTP 403');
    try{await c.call('/api/admin/oauth-accounts');}catch(error){expect(String(error)).not.toContain('private-secret');}
  });
});
