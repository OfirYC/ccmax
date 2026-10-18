import { describe,it,expect } from 'vitest';
import { ProviderClient,UpstreamError } from './providers.js';
import { parseProxy } from './proxies.js';

const credentials={username:'shared-login',password:'shared-password'};

describe('Gatelink OAuth request contract',()=>{
  it.each(['socks5','socks5h','http','https'])('serializes %s proxies in both OAuth steps without changing the saved identity',async scheme=>{
    const options={email:'claude@example.com',accountType:'stable',proxy:parseProxy(`${scheme}://user:p%40ss%3Aword@PROXY.example.com:1080`).url};
    const saved=JSON.stringify(options),requests:{path:string;body:any}[]=[];
    const c=new ProviderClient('gatelink',credentials,async(input,init)=>{
      const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));
      requests.push({path,body});
      // Gatelink's public client documents socks5://, not our internal socks5h://.
      if(!['socks5:','http:','https:'].includes(new URL(body.proxy).protocol))return Response.json({issues:[{path:['proxy'],message:'unsupported scheme'}]},{status:422});
      expect(body).toMatchObject({loginMethod:options.email,accountType:'stable',oauthFlow:'login'});
      if(path.endsWith('/authorize')){expect(body.overwriteExisting).toBe(false);return Response.json({authorizationUrl:'https://auth.example.com/?state=saved-state'});}
      expect(body.callback).toBe('one-use-code#saved-state');
      return Response.json({item:{id:'submitted',upstreamEmail:options.email,upstreamDailyCost:'0'}});
    });
    const attempt=await c.startOAuth(options);
    const remote=await c.exchangeOAuth(attempt.secret,'  one-use-code#saved-state\n');
    expect(remote.email).toBe(options.email);
    expect(requests.map(r=>r.path)).toEqual(['/api/oauth-submissions/authorize','/api/oauth-submissions/exchange']);
    const protocol=scheme.startsWith('socks5')?'socks5':scheme;
    expect(requests.map(r=>r.body.proxy)).toEqual(Array(2).fill(`${protocol}://user:p%40ss%3Aword@proxy.example.com:1080`));
    expect(JSON.stringify(options)).toBe(saved);
    expect(JSON.stringify(attempt.secret.options)).toBe(saved);
  });

  it('rejects account types belonging to other providers before making a Gatelink request',async()=>{
    let calls=0;
    const c=new ProviderClient('gatelink',credentials,async()=>{calls++;return Response.json({});});
    for(const accountType of ['max','pro'])await expect(c.startOAuth({email:'claude@example.com',accountType,proxy:'http://proxy.example.com:8080'})).rejects.toThrow('speed、stable 或 team');
    expect(calls).toBe(0);
  });
});

describe('Gatelink error diagnosis',()=>{
  const privateValue='private-oauth-code-and-proxy-password';
  const rejected=(body:unknown,path='/api/oauth-submissions/authorize')=>{
    let calls=0;
    const client=new ProviderClient('gatelink',credentials,async()=>{calls++;return Response.json(body,{status:422});});
    return {request:()=>client.call(path),calls:()=>calls};
  };
  it.each([
    ['/api/auth/login','登录'],['/api/settings/submission','读取上号配置'],['/api/submissions?page=1&pageSize=100','同步账号'],
    ['/api/oauth-submissions/authorize','生成授权链接'],['/api/oauth-submissions/exchange','提交授权回调'],
    ['/api/admin/accounts/private-id/enabled','修改账号状态'],['/api/unknown?code=private-code','请求'],
  ])('identifies the failed operation for %s without exposing paths or retrying',async(path,operation)=>{
    const {request,calls}=rejected({message:privateValue},path);
    const error=await request().catch(error=>error);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({upstreamStatus:422,statusCode:502});
    expect(error.message).toContain(`Gatelink ${operation}失败（HTTP 422）`);
    expect(error.message).not.toContain(privateValue);
    expect(error.message).not.toContain(path);
    expect(calls()).toBe(1);
  });

  it.each([
    {issues:[{path:['proxy'],message:privateValue,input:privateValue}]},
    {error:{issues:[{path:['proxy'],message:privateValue}]}},
    {details:{fieldErrors:{proxy:[privateValue]}}},
    {errors:{proxy:[privateValue]}},
    {detail:[{loc:['body','proxy'],msg:privateValue,input:privateValue}]},
  ])('extracts known validation fields from structured errors without echoing values',async body=>{
    const {request}=rejected(body);
    const error=await request().catch(error=>error);
    expect(error.message).toContain('参数校验未通过：proxy');
    expect(error.message).not.toContain(privateValue);
  });

  it('reports a nested upstream rejection separately from request validation',async()=>{
    const {request}=rejected({error:privateValue,upstream:{httpStatus:'422',detail:privateValue,headers:{authorization:privateValue}}});
    const error=await request().catch(error=>error);
    expect(error.message).toContain('Gatelink 的上游返回 HTTP 422');
    expect(error.message).not.toContain('参数校验未通过');
    expect(error.message).not.toContain(privateValue);
  });

  it.each([
    {issues:[{path:[privateValue],message:privateValue}],message:privateValue},
    {upstream:{httpStatus:privateValue},message:privateValue},
    {message:privateValue,padding:'x'.repeat(32768)},
    '<html>'+privateValue+'</html>',
    null,
  ])('uses a safe fallback for unrecognized, oversized or malformed responses',async body=>{
    const c=new ProviderClient('gatelink',credentials,async()=>typeof body==='string'?new Response(body,{status:422}):Response.json(body,{status:422}));
    const error=await c.call('/api/oauth-submissions/exchange').catch(error=>error);
    expect(error.message).toContain('HTTP 422');
    expect(error.message).toContain('请求被拒绝');
    expect(error.message).not.toContain(privateValue);
  });
});
