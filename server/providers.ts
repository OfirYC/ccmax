import { AppError, assert } from './core.js';

export const PROVIDERS = {
  gatelink: { name:'Gatelink', url:'https://cc.gatelink.dev', oauth:true, refreshTokenImport:false, historicalUsage:false },
  ai008: { name:'AI008', url:'https://ai008.xyz', oauth:true, refreshTokenImport:true, historicalUsage:true },
} as const;
export type ProviderKey=keyof typeof PROVIDERS;
export type Credentials={username:string;password:string};
export type UpstreamAccount={id:string;email:string;name:string;status:string;dailyUsd:string;cost7d:string|null;cost30d:string|null;utilization:number|null};
export type OAuthOptions={email:string;proxy?:string;accountType?:string;policyTemplateId?:string;groupIds?:string[];ccTemplateId?:string};
export class UpstreamError extends AppError {
  constructor(public upstreamStatus:number, message:string) { super(502,message); }
}

export class ProviderClient {
  private cookies=new Map<string,string>();
  private token='';
  private csrf='';
  public user:any;
  constructor(public provider:ProviderKey,private credentials:Credentials,private request:typeof fetch=fetch) {}
  exportSession() { return {cookies:[...this.cookies],token:this.token,csrf:this.csrf,user:this.user}; }
  restoreSession(session:any) { this.cookies=new Map(session.cookies);this.token=session.token;this.csrf=session.csrf;this.user=session.user; }
  async call(path:string,method='GET',body?:unknown) {
    assert(path.startsWith('/api/') && !path.includes('://'),'非法平台接口路径');
    const base=PROVIDERS[this.provider].url;
    const headers:Record<string,string>={'Content-Type':'application/json','Accept':'application/json','Origin':base};
    if(this.cookies.size) headers.Cookie=[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    if(this.token) headers.Authorization=`Bearer ${this.token}`;
    if(this.csrf && method!=='GET') headers['x-csrf-token']=this.csrf;
    let response:Response;
    try { response=await this.request(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)}); }
    catch { throw new UpstreamError(0,'平台连接超时或网络异常；写入结果可能未知，请核对后操作'); }
    for(const cookie of response.headers.getSetCookie()) {
      const pair=cookie.split(';')[0], index=pair.indexOf('=');
      if(index>0) this.cookies.set(pair.slice(0,index),pair.slice(index+1));
    }
    // Never expose a raw upstream body: account APIs can contain tokens/proxies.
    if(!response.ok) throw new UpstreamError(response.status,`平台返回 HTTP ${response.status}${response.status===403?'：当前主账号无此权限':''}`);
    if(response.status===204) return {};
    try { return await response.json() as any; }
    catch { throw new UpstreamError(response.status,'平台响应格式变化，请检查适配器'); }
  }
  async login() {
    if(this.provider==='gatelink') {
      const data=await this.call('/api/auth/login','POST',{username:this.credentials.username,password:this.credentials.password});
      assert(data.user && data.csrfToken,'Gatelink 登录响应缺少会话信息',502);
      this.csrf=data.csrfToken;this.user=data.user;
    } else {
      const data=await this.call('/api/auth/admin-login','POST',{identifier:this.credentials.username,email:this.credentials.username,password:this.credentials.password});
      assert(data.accessToken && data.user,'AI008 登录响应缺少会话信息',502);
      this.token=data.accessToken;this.user=data.user;
    }
    return {role:this.user.role,username:this.user.username};
  }
  async listAccounts():Promise<UpstreamAccount[]> {
    const result:UpstreamAccount[]=[];
    for(let page=1;page<=1000;page++) {
      const data=await this.call(this.provider==='gatelink'?`/api/submissions?page=${page}&pageSize=100`:`/api/admin/oauth-accounts?page_mode=1&page=${page}&page_size=100`);
      const items=this.provider==='gatelink'?data.items:data.accounts;
      assert(Array.isArray(items),'平台账号列表格式变化',502);
      for(const a of items) {
        const email=this.provider==='gatelink'?(a.upstreamEmail||a.submittedEmail||a.email):(a.email||a.canonical_identity?.email);
        if(!email) continue;
        result.push(this.normalize(a));
      }
      const totalPages=this.provider==='gatelink'?data.totalPages:(data.pagination?.total_pages??data.pagination?.totalPages);
      const total=this.provider==='gatelink'?data.total:(data.pagination?.total??data.pagination?.total_count);
      if(totalPages!==undefined && page>=Number(totalPages)) return result;
      if(total!==undefined && page*100>=Number(total)) return result;
      if(items.length<100) return result;
    }
    throw new UpstreamError(0,'平台账号超过分页上限，本次同步未提交');
  }
  normalize(a:any):UpstreamAccount {
    const gate=this.provider==='gatelink';
    const snapshot=gate?a.upstreamSnapshot:a;
    const email=(gate?(a.upstreamEmail||a.submittedEmail||a.email):(a.email||a.canonical_identity?.email))?.toLowerCase();
    assert(a.id && email,'平台未返回账号 ID / 邮箱',502);
    return {id:String(a.id),email,name:a.name||email,status:gate?(a.upstreamStatus||a.status||'unknown'):(a.status||'unknown'),
      dailyUsd:String((gate?a.upstreamDailyCost:a.stats?.daily_cost)??0),
      cost7d:(gate?a.upstreamCost7d:a.usage_windows?.cost_7d)??snapshot?.usage_windows?.cost_7d??null,
      cost30d:snapshot?.usage_windows?.cost_30d??null,
      utilization:(gate?a.upstreamUtilization5h:a.stats?.claude_utilization?.five_hour?.utilization)??null};
  }
  async options() {
    if(this.provider==='gatelink') {
      const settings=await this.call('/api/settings/submission');
      return {requireProxy:true,accountTypes:['speed','stable','team'],settings:{proxyMode:settings.proxyMode}};
    }
    const [groups,policies,templates]=await Promise.all([
      this.call('/api/admin/groups'),this.call('/api/admin/account-policy-templates'),this.call('/api/admin/cc-disguise-templates'),
    ]);
    const clean=(data:any,key:string)=>{
      const list=Array.isArray(data)?data:(data.items??data[key]??[]);
      return list.map((v:any)=>({id:v.id,name:v.name}));
    };
    return {requireProxy:false,accountTypes:['max','pro','team'],groups:clean(groups,'groups'),policies:clean(policies,'templates'),templates:clean(templates,'templates')};
  }
  private aiConfig(options:OAuthOptions) {
    return {provider:'anthropic',oauth_flow:'login',name:options.email,inference_backend:'native',
      ...(options.accountType?{account_type:options.accountType}:{}),
      outbound_proxy_mode:options.proxy?'manual':'auto',outbound_proxy_id:options.proxy||null,
      ...(options.policyTemplateId?{policy_template_id:options.policyTemplateId}:{}),
      ...(options.groupIds?.length?{group_ids:options.groupIds}:{}),
      ...(options.ccTemplateId?{cc_template_id:options.ccTemplateId}:{}),
    };
  }
  async startOAuth(options:OAuthOptions) {
    if(this.provider==='gatelink') {
      assert(options.proxy,'Gatelink 要求为每个账号填写独立出口代理');
      const data=await this.call('/api/oauth-submissions/authorize','POST',{accountType:options.accountType||'speed',oauthFlow:'login',loginMethod:options.email,proxy:options.proxy,overwriteExisting:false});
      assert(data.authorizationUrl,'平台未返回授权地址',502);
      return {url:data.authorizationUrl,secret:{options},expiresIn:Math.min(data.expiresInSeconds||600,1800)};
    }
    const data=await this.call('/api/admin/oauth-accounts/auth-url','POST',this.aiConfig(options));
    assert(data.url && data.state,'平台未返回 OAuth URL / state',502);
    return {url:data.url,secret:{options,pendingState:data.state},expiresIn:600};
  }
  async exchangeOAuth(secret:any,callback:string) {
    if(this.provider==='gatelink') {
      const data=await this.call('/api/oauth-submissions/exchange','POST',{callback,loginMethod:secret.options.email,accountType:secret.options.accountType||'speed',oauthFlow:'login',proxy:secret.options.proxy});
      assert(data.item,'平台未返回已提交账号',502);
      return this.normalize(data.item);
    }
    let code=callback.trim();
    if(/^https?:\/\//.test(code)) { const url=new URL(code);code=url.searchParams.get('code')||'';const state=url.searchParams.get('state');assert(!state||state===secret.pendingState,'OAuth state 不匹配'); }
    code=code.split('#')[0];
    assert(code.length>0,'请输入有效的授权码');
    const data=await this.call('/api/admin/oauth-accounts/exchange','POST',{...this.aiConfig(secret.options),code,pending_state:secret.pendingState});
    assert(data.id,'平台未返回账号 ID',502);
    return {id:String(data.id),email:(data.email||secret.options.email).toLowerCase(),name:secret.options.email,status:'active',dailyUsd:'0',cost7d:null,cost30d:null,utilization:null};
  }
  async importRefreshToken(options:OAuthOptions,refreshToken:string) {
    assert(this.provider==='ai008','Gatelink 当前接口不支持 refresh token 导入，需单独完成 OAuth 授权');
    const data=await this.call('/api/admin/oauth-accounts/import-rt','POST',{...this.aiConfig(options),refresh_token:refreshToken});
    assert(data.id,'平台未返回账号 ID',502);
    return {id:String(data.id),email:(data.email||options.email).toLowerCase(),name:options.email,status:'active',dailyUsd:'0',cost7d:null,cost30d:null,utilization:null};
  }
  async setEnabled(externalId:string,enabled:boolean) {
    if(this.provider==='gatelink') return this.call(`/api/admin/accounts/${encodeURIComponent(externalId)}/enabled`,'POST',{enabled});
    return this.call(`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`,'PATCH',{status:enabled?'active':'disabled'});
  }
  async historicalDay(day:string):Promise<{externalId:string;rawUsd:string}[]> {
    assert(this.provider==='ai008','当前 Gatelink 主账号没有历史结算接口权限，请导入上游确认的日账单');
    const data=await this.call('/api/admin/vendor-usage/queries','POST',{since:`${day}T00:00:00+08:00`,until:`${day}T23:59:59+08:00`,granularity:'day'});
    assert(data.task?.id,'历史查询接口响应变化',502);
    let first:any;
    for(let n=0;n<25;n++) {
      first=await this.call(`/api/admin/vendor-usage/queries/${encodeURIComponent(data.task.id)}?page=1&account_page=1`);
      if(first.task?.status==='succeeded'||first.task?.status==='completed') break;
      assert(!['failed','cancelled'].includes(first.task?.status),'上游历史查询失败',502);
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    assert(first?.result && ['succeeded','completed'].includes(first.task?.status),'历史查询尚未完成，请稍后重新查询',502);
    const result=first.result;
    assert(Array.isArray(result.accounts),'上游历史结果缺少逐账号用量；未写入账本',502);
    const rows=[...result.accounts];
    const count=Number(result.account_count??rows.length),pageSize=Number(result.page_size??rows.length);
    assert(pageSize>0 || count===0,'历史查询分页格式变化',502);
    for(let page=2;page<=Math.ceil(count/pageSize);page++) {
      const next=await this.call(`/api/admin/vendor-usage/queries/${encodeURIComponent(data.task.id)}?page=1&account_page=${page}`);
      assert(Array.isArray(next.result?.accounts),'历史查询分页结果不完整',502);
      rows.push(...next.result.accounts);
    }
    assert(rows.length===count,'历史账号结果不完整，未写入账本',502);
    return rows.map((r:any)=>{ assert(r.account_id && r.cost!==undefined,'历史用量字段缺失',502);return {externalId:String(r.account_id),rawUsd:String(r.cost)}; });
  }
}
