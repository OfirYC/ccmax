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
  it('uses the Aeromax provider session, keeps points/CNY out of USD billing, and reads only own accounts',async()=>{
    const paths:string[]=[];
    const c=new ProviderClient('aeromax',{username:'provider@example.com',password:'provider-password'},async(url,init)=>{
      const parsed=new URL(String(url));paths.push(parsed.pathname);
      if(parsed.pathname==='/api/v1/auth/login'){
        expect(JSON.parse(String(init?.body))).toEqual({email:'provider@example.com',password:'provider-password',intendedRole:'provider'});
        return new Response(JSON.stringify({role:'provider',email:'provider@example.com'}),{headers:{'content-type':'application/json','set-cookie':'aeromax_session=opaque-session; Path=/; HttpOnly'}});
      }
      if(parsed.pathname==='/api/v1/provider/settlement')return Response.json({today:'2026-10-31',pointsToday:12,owedTodayMinor:670,paidTodayMinor:0,balanceTodayMinor:670,owedMinor:1340,paidMinor:670,balanceMinor:670,rows:[{owedMinor:670}]});
      if(parsed.pathname==='/api/v1/view/provider')return Response.json({role:'provider',email:'provider@example.com',accounts:[{providerId:'provider-account-1',displayName:'slot',health:'healthy',lastError:null,money:{tag:'provider_payable',verifiedPointsMinor:1234,posted:{amountMinor:456,currency:'CNY'},paid:{amountMinor:0,currency:'CNY'}},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false},service:{ownerEmail:'claude-owner@example.com',requests:8,refusedRequests:1,inputTokens:100,outputTokens:50,deployment:'ready',rpm:2,rpmLimit:10,activity:{requestsToday:8,requestsRecent:3,windows:{h5:{requests:3,utilization:.2,windowEnd:null},d7:{requests:8,utilization:.3,windowEnd:null}}}}}],live:{accounts:1,requestsRecent:3,requestsToday:8,rpm:2,rpmCapacity:10,eligible:1,healthy:1,rateLimited:0,reauth:0,degraded:0,retired:0,pointsToday:12,pointsTotal:1234,ledgerBasis:true,windows:{h5:{utilization:.2,open:1,reporting:1},d7:{utilization:.3,open:1,reporting:1},f5:{utilization:.1,open:1,reporting:1}}},timeline:[],earnings:{tag:'provider_payable',verifiedPointsMinor:1234},uploader:{state:'ready',detail:'ready'},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false}});
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    await c.login();const accounts=await c.listAccounts();expect(accounts).toHaveLength(1);expect(accounts[0]).toMatchObject({id:'provider-account-1',email:'claude-owner@example.com',dailyUsd:null,status:'active'});expect(accounts[0].telemetry?.periods.today.billedUsd).toBeNull();expect(accounts[0].telemetry?.periods.today.requests).toBe(8);expect(c.providerSnapshot.settlement).toMatchObject({currency:'CNY',usdCurrency:'USD',cnyPerUsd:'6.7',pointsToday:12,owedTodayMinor:670,owedTodayUsdMinor:100,owedUsdMinor:200,paidUsdMinor:100,balanceUsdMinor:100,sourceOk:true});expect(paths).toEqual(['/api/v1/auth/login','/api/v1/view/provider','/api/v1/provider/settlement']);
  });
  it('runs Aeromax uploader authorization with a fixed URL proxy and verifies the resulting account',async()=>{
    let viewCalls=0;const c=new ProviderClient('aeromax',{username:'provider@example.com',password:'provider-password'},async(url,init)=>{
      const parsed=new URL(String(url));
      if(parsed.pathname==='/api/v1/auth/login')return new Response(JSON.stringify({role:'provider',email:'provider@example.com'}),{headers:{'content-type':'application/json','set-cookie':'aeromax_session=opaque-session; Path=/; HttpOnly'}});
      if(parsed.pathname==='/api/v1/provider/uploader/sessions'){expect(JSON.parse(String(init?.body))).toMatchObject({httpProxy:'http://proxy.example.com:8080',acceptDirectRisk:false});return Response.json({id:'11111111-1111-4111-8111-111111111111',authorizationUrl:'https://claude.ai/oauth/authorize?opaque=1',expiresAt:Date.now()+600000});}
      if(parsed.pathname==='/api/v1/provider/uploader/authorize'){expect(JSON.parse(String(init?.body))).toMatchObject({sessionId:'11111111-1111-4111-8111-111111111111',code:'one-time-code',name:'claude-owner@example.com'});return Response.json({id:'22222222-2222-4222-8222-222222222222',status:'succeeded',phase:'complete',message:'ok',name:'claude-owner@example.com',providerId:'provider-account-1',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});}
      if(parsed.pathname==='/api/v1/view/provider'){viewCalls++;return Response.json({role:'provider',email:'provider@example.com',accounts:[{providerId:'provider-account-1',displayName:'slot',health:'healthy',lastError:null,money:{tag:'unpriced',verifiedPointsMinor:0},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false},service:{ownerEmail:'claude-owner@example.com',requests:0,refusedRequests:0,inputTokens:0,outputTokens:0,deployment:'ready'}}],live:{accounts:1,requestsRecent:0,requestsToday:0,rpm:0,rpmCapacity:null,eligible:1,healthy:1,rateLimited:0,reauth:0,degraded:0,retired:0,pointsToday:null,pointsTotal:0,ledgerBasis:true,windows:{h5:{utilization:0,open:1,reporting:1},d7:{utilization:0,open:1,reporting:1},f5:{utilization:0,open:1,reporting:1}}},timeline:[],earnings:{tag:'unpriced',verifiedPointsMinor:0},uploader:{state:'ready',detail:'ready'},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false}});}
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    await c.login();const attempt=await c.startOAuth({email:'claude-owner@example.com',proxy:'http://proxy.example.com:8080'});expect(attempt.url).toContain('claude.ai');const remote=await c.exchangeOAuth(attempt.secret,'one-time-code');expect(remote.id).toBe('provider-account-1');expect(viewCalls).toBe(1);
  });
  it('forces the Aeromax uploader only after its documented instance conflict',async()=>{
    const authorizeBodies:any[]=[];
    const c=new ProviderClient('aeromax',{username:'provider@example.com',password:'provider-password'},async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/api/v1/auth/login')return new Response(JSON.stringify({role:'provider',email:'provider@example.com'}),{headers:{'content-type':'application/json','set-cookie':'aeromax_session=opaque-session; Path=/; HttpOnly'}});
      if(path==='/api/v1/provider/uploader/sessions')return Response.json({id:'11111111-1111-4111-8111-111111111111',authorizationUrl:'https://claude.ai/oauth/authorize?opaque=1',expiresAt:Date.now()+600000});
      if(path==='/api/v1/provider/uploader/authorize'){
        const body=JSON.parse(String(init?.body));authorizeBodies.push(body);
        if(!body.force)return Response.json({error:'instance_exists',name:'stale-worker',hostLabel:null,vmId:null,phase:'running',since:new Date().toISOString()},{status:409});
        return Response.json({id:'22222222-2222-4222-8222-222222222222',status:'succeeded',phase:'complete',message:'ok',name:'claude-owner@example.com',providerId:'provider-account-1',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      }
      if(path==='/api/v1/view/provider')return Response.json({role:'provider',email:'provider@example.com',accounts:[{providerId:'provider-account-1',displayName:'slot',health:'healthy',lastError:null,money:{tag:'unpriced',verifiedPointsMinor:0},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false},service:{ownerEmail:'claude-owner@example.com',requests:0,refusedRequests:0,inputTokens:0,outputTokens:0,deployment:'ready'}}],live:{accounts:1,requestsRecent:0,requestsToday:0,rpm:0,rpmCapacity:null,eligible:1,healthy:1,rateLimited:0,reauth:0,degraded:0,retired:0,pointsToday:null,pointsTotal:0},timeline:[],earnings:{tag:'unpriced',verifiedPointsMinor:0},uploader:{state:'ready',detail:'ready'},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false}});
      throw new Error(`unexpected ${path}`);
    });
    await c.login();const attempt=await c.startOAuth({email:'claude-owner@example.com',proxy:'http://proxy.example.com:8080'});
    const remote=await c.exchangeOAuth(attempt.secret,'one-time-code',true);
    expect(remote.id).toBe('provider-account-1');
    expect(authorizeBodies).toEqual([
      {sessionId:attempt.secret.sessionId,code:'one-time-code',name:'claude-owner@example.com'},
      {sessionId:attempt.secret.sessionId,code:'one-time-code',name:'claude-owner@example.com',force:true},
    ]);
  });
  it.each([
    {error:{code:'instance_exists',message:'an instance already exists'}},
    {code:'INSTANCE-EXISTS',message:'an instance already exists'},
    {error:{details:{reason:'instance_exists'}}},
    {error_code:'InstanceExistsError'},
  ])('recognizes a documented Aeromax instance conflict in alternate safe response shapes',async conflict=>{
    const authorizeBodies:any[]=[];
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/api/v1/provider/uploader/authorize') {
        const body=JSON.parse(String(init?.body));authorizeBodies.push(body);
        return body.force
          ?Response.json({id:'task',status:'succeeded',providerId:'provider-account'})
          :Response.json(conflict,{status:409});
      }
      if(path==='/api/v1/view/provider')return Response.json({role:'provider',email:'fixture',accounts:[{providerId:'provider-account',displayName:'slot',health:'healthy',lastError:null,money:{tag:'unpriced',verifiedPointsMinor:0},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false},service:{ownerEmail:'owner@example.com',requests:0,refusedRequests:0,inputTokens:0,outputTokens:0,deployment:'ready'}}],live:{accounts:1,requestsRecent:0,requestsToday:0,rpm:0,rpmCapacity:null,eligible:1,healthy:1,rateLimited:0,reauth:0,degraded:0,retired:0,pointsToday:null,pointsTotal:0},timeline:[],earnings:{tag:'unpriced',verifiedPointsMinor:0},uploader:{state:'ready',detail:'ready'},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false}});
      throw new Error(`unexpected ${path}`);
    });
    const remote=await c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'session'},'single-use-code',true);
    expect(remote.id).toBe('provider-account');
    expect(authorizeBodies.map(body=>body.force)).toEqual([undefined,true]);
  });
  it('reports a bounded sanitized Aeromax error contract without exposing the response body',async()=>{
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async()=>Response.json({
      error:{code:'account_conflict',message:'Owner private@example.com callback https://callback.example/?code=one-use-secret'},
      phase:'initial',access_token:'private-token',httpProxy:'http://user:password@proxy.example.com:8080',authorizationUrl:'https://private.example/auth',
    },{status:422,headers:{'x-request-id':'req-safe-123'}}));
    const error=await c.call('/api/v1/provider/uploader/authorize','POST',{code:'one-use-secret'}).catch(error=>error);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({upstreamStatus:422,upstreamCode:'account_conflict'});
    expect(error.message).toContain('account_conflict');
    expect(error.message).toContain('phase=initial');
    expect(error.diagnostic).toMatchObject({status:422,format:'json',requestId:'req-safe-123',code:'account_conflict'});
    const visible=JSON.stringify({message:error.message,diagnostic:error.diagnostic});
    expect(visible).not.toContain('private@example.com');
    expect(visible).not.toContain('callback.example');
    expect(visible).not.toContain('one-use-secret');
    expect(visible).not.toContain('private-token');
    expect(visible).not.toContain('user:password');
    expect(visible).not.toContain('private.example');
  });
  it('retries a confirmed Aeromax provider-name collision once with a unique name',async()=>{
    const authorizeBodies:any[]=[];
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/api/v1/provider/uploader/authorize') {
        const body=JSON.parse(String(init?.body));authorizeBodies.push(body);
        return authorizeBodies.length===1
          ?Response.json({error:'arx_request_rejected',detail:'upstream HTTP 409: 提供商名称已存在，请换一个名称'},{status:409})
          :Response.json({id:'task',status:'succeeded',providerId:'provider-account'});
      }
      if(path==='/api/v1/view/provider')return Response.json({role:'provider',email:'fixture',accounts:[{providerId:'provider-account',displayName:'slot',health:'healthy',lastError:null,money:{tag:'unpriced',verifiedPointsMinor:0},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false},service:{ownerEmail:'owner@example.com',requests:0,refusedRequests:0,inputTokens:0,outputTokens:0,deployment:'ready'}}],live:{accounts:1,requestsRecent:0,requestsToday:0,rpm:0,rpmCapacity:null,eligible:1,healthy:1,rateLimited:0,reauth:0,degraded:0,retired:0,pointsToday:null,pointsTotal:0},timeline:[],earnings:{tag:'unpriced',verifiedPointsMinor:0},uploader:{state:'ready',detail:'ready'},stamp:{sourceId:'source',asOf:new Date().toISOString(),freshness:'fresh',staged:false}});
      throw new Error(`unexpected ${path}`);
    });
    const remote=await c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'11111111-1111-4111-8111-111111111111'},'single-use-code',true);
    expect(remote.id).toBe('provider-account');
    expect(authorizeBodies).toHaveLength(2);
    expect(authorizeBodies[0]).toMatchObject({name:'owner@example.com'});
    expect(authorizeBodies[1].name).toMatch(/^owner@example\.com-[a-f0-9]{8}$/);
    expect(authorizeBodies[1].force).toBeUndefined();
  });
  it('does not replay an Aeromax OAuth code for an unrelated ARX rejection',async()=>{
    let writes=0;
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async()=>{
      writes++;return Response.json({error:'arx_request_rejected',detail:'upstream HTTP 409: account policy denied'},{status:409});
    });
    const error=await c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'session'},'single-use-code',true).catch(error=>error);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(writes).toBe(1);
  });
  it('identifies a non-JSON Aeromax failure without exposing its raw body',async()=>{
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async()=>new Response('oauth_code=private-one-use-code',{status:503,headers:{'content-type':'text/html','x-request-id':'req-html-503'}}));
    const error=await c.call('/api/v1/provider/uploader/authorize','POST',{}).catch(error=>error);
    expect(error).toMatchObject({upstreamStatus:503,diagnostic:{status:503,format:'non_json',contentType:'text/html',responseBytes:31,requestId:'req-html-503'}});
    expect(error.message).toContain('format=non_json');
    expect(JSON.stringify(error)).not.toContain('private-one-use-code');
  });
  it('requires explicit consent before replacing an existing Aeromax uploader instance',async()=>{
    const bodies:any[]=[];
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async(_url,init)=>{
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({error:'instance_exists',name:'active-instance',phase:'running'},{status:409});
    });
    await expect(c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'session'},'single-use-code'))
      .rejects.toMatchObject({statusCode:409,code:'UPSTREAM_INSTANCE_EXISTS'});
    expect(bodies).toHaveLength(1);expect(bodies[0].force).toBeUndefined();
  });
  it.each([
    [409,'{"error":"another_conflict","token":"private-token"}'],
    [409,'not-json private-token'],[409,'null'],[403,'{"error":"instance_exists"}'],[503,'{"error":"instance_exists"}'],
  ])('never forces an unknown or unsuccessful authorization response (%s, %s)',async(status,body)=>{
    let calls=0;
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async()=>{calls++;return new Response(body,{status});});
    const error=await c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'session'},'single-use-code',true).catch(error=>error);
    expect(error).toBeInstanceOf(UpstreamError);expect(error.message).toContain('平台 E 初次上号请求失败');expect(error.message).not.toContain('private-token');expect(calls).toBe(1);
  });
  it('identifies an Aeromax task polling failure without exposing its response body',async()=>{
    const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async(url)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/api/v1/provider/uploader/authorize')return Response.json({id:'task-id',status:'queued'});
      if(path==='/api/v1/provider/uploader/tasks/task-id')return new Response('private-token',{status:409});
      throw new Error(`unexpected ${path}`);
    });
    const error=await c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'session'},'single-use-code',true).catch(error=>error);
    expect(error).toBeInstanceOf(UpstreamError);expect(error.message).toContain('平台 E 上号任务状态检查失败');expect(error.message).not.toContain('private-token');
  });
  it('retries only confirmed Aeromax instance conflicts and never retries an uncertain write',async()=>{
    for(const networkFailure of [false,true]) {
      const bodies:any[]=[];
      const c=new ProviderClient('aeromax',{username:'fixture',password:'fixture'},async(_url,init)=>{
        bodies.push(JSON.parse(String(init?.body)));
        if(networkFailure)throw new Error('private network details');
        return Response.json({error:'instance_exists'},{status:409});
      });
      const error=await c.exchangeOAuth({options:{email:'owner@example.com',proxy:fixedProxy.proxy},sessionId:'session'},'single-use-code',true).catch(error=>error);
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.message).toContain(networkFailure?'平台 E 初次上号请求失败':'平台 E 替换已有实例失败');
      expect(bodies.map(body=>body.force)).toEqual(networkFailure?[undefined]:[undefined,true,true,true]);
    }
  });
  it('blocks Gatelink account status writes with an agent session and permits an authenticated upstream admin',async()=>{
    let writes=0;
    const c=new ProviderClient('gatelink',{username:'fixture',password:'fixture'},async(url,init)=>{writes++;expect(String(url)).toContain('/api/admin/accounts/existing/enabled');expect(JSON.parse(String(init?.body))).toEqual({enabled:false});return Response.json({});});
    c.user={role:'agent'};await expect(c.setEnabled('existing',false)).rejects.toThrow('上游管理员权限');expect(writes).toBe(0);
    c.user={role:'admin'};await c.setEnabled('existing',false);expect(writes).toBe(1);
  });
});
