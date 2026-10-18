import { AppError, assert,MAX_USD } from './core.js';
import Decimal from 'decimal.js';
import { parseProxy } from './proxies.js';
import { gatelinkFailure } from './gatelink-errors.js';
import { statefulOAuthCallback } from './oauth-callback.js';
import { normalizeTelemetry,normalizeModelAmounts } from './telemetry.js';
import { telemetryPeriods,type AccountTelemetry } from '../shared/telemetry.js';

export const PROVIDERS = {
  gatelink: { name:'Gatelink', url:'https://cc.gatelink.dev', oauth:true, refreshTokenImport:false, historicalUsage:false,statusRequiresAdmin:true },
  ai008: { name:'AI008', url:'https://ai008.xyz', oauth:true, refreshTokenImport:true, historicalUsage:true,statusRequiresAdmin:false },
  minicc: { name:'Mini CC Gateway', url:'http://207.57.170.28:8096', oauth:true, refreshTokenImport:true, historicalUsage:true,statusRequiresAdmin:false },
} as const;
export type ProviderKey=keyof typeof PROVIDERS;
export const PROVIDER_KEYS=Object.keys(PROVIDERS) as [ProviderKey,...ProviderKey[]];
export type Credentials={username:string;password:string};
export type UpstreamAccount={id:string;email:string;name:string;status:string;dailyUsd:string|null;cost7d:string|null;cost30d:string|null;utilization:number|null;proxyExternalId?:string|null;telemetry?:AccountTelemetry};
export type OAuthOptions={email:string;proxy?:string;proxyExternalId?:string;accountType?:string;policyTemplateId?:string;groupIds?:string[];ccTemplateId?:string};
export class UpstreamError extends AppError {
  constructor(public upstreamStatus:number, message:string) { super(502,message); }
}
function upstreamAmount(value:unknown,message:string) {
  assert(typeof value==='string'||typeof value==='number',message,502);
  let amount:Decimal;
  try { amount=new Decimal(value); } catch { throw new UpstreamError(200,message); }
  assert(amount.isFinite() && amount.gte(0),message,502);
  return amount;
}
function historicalRows(rows:any[]):{externalId:string;rawUsd:string}[] {
  const seen=new Set<string>();
  return rows.map(r=>{
    assert(r && (typeof r.account_id==='string'||typeof r.account_id==='number') && String(r.account_id).trim() && r.cost!==undefined && r.cost!==null,'历史用量字段缺失',502);
    const raw=upstreamAmount(r.cost,'历史用量金额或账号重复，未写入账本'),externalId=String(r.account_id);
    assert(raw.lte(MAX_USD),'历史用量金额或账号重复，未写入账本',502);
    assert(!seen.has(externalId),'历史用量金额或账号重复，未写入账本',502);
    seen.add(externalId);return {externalId,rawUsd:raw.toFixed()};
  });
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
    if(!response.ok) throw new UpstreamError(response.status,this.provider==='gatelink'?await gatelinkFailure(response,path):`平台返回 HTTP ${response.status}${response.status===403?'：当前主账号无此权限':''}`);
    if(response.status===204) return {};
    try { return await response.json() as any; }
    catch { throw new UpstreamError(response.status,'平台响应格式变化，请检查适配器'); }
  }
  async login() {
    if(this.provider==='gatelink') {
      const data=await this.call('/api/auth/login','POST',{username:this.credentials.username,password:this.credentials.password});
      assert(data.user && data.csrfToken,'Gatelink 登录响应缺少会话信息',502);
      this.csrf=data.csrfToken;this.user=data.user;
    } else if(this.provider==='minicc') {
      await this.call('/api/login','POST',this.credentials);
      const data=await this.call('/api/me');
      assert(data.authenticated===true && data.user && this.cookies.size>0,'Mini CC 登录响应缺少有效会话',502);
      this.user=data.user;
    } else {
      const data=await this.call('/api/auth/admin-login','POST',{identifier:this.credentials.username,email:this.credentials.username,password:this.credentials.password});
      assert(data.accessToken && data.user,'AI008 登录响应缺少会话信息',502);
      this.token=data.accessToken;this.user=data.user;
    }
    return {role:this.user.role,username:this.user.username};
  }
  async listAccounts():Promise<UpstreamAccount[]> {
    const result:UpstreamAccount[]=[];
    const seen=new Set<string>(),emails=new Set<string>();let declaredTotal:number|undefined;
    for(let page=1;page<=1000;page++) {
      const data=await this.call(this.provider==='gatelink'?`/api/submissions?page=${page}&pageSize=100`:this.provider==='minicc'?`/api/accounts?page=${page}&page_size=100`:`/api/admin/oauth-accounts?page_mode=1&page=${page}&page_size=100`);
      const items=this.provider==='gatelink'?data.items:data.accounts;
      assert(Array.isArray(items),'平台账号列表格式变化',502);
      if(this.provider==='minicc') {
        assert(Number.isInteger(data.pages) && data.pages>=1 && Number.isInteger(data.total) && data.total>=0,'平台分页格式变化',502);
      }
      const totalPages=this.provider==='gatelink'?data.totalPages:this.provider==='minicc'?data.pages:(data.pagination?.total_pages??data.pagination?.totalPages);
      const total=this.provider==='gatelink'?data.total:this.provider==='minicc'?data.total:(data.pagination?.total_rows??data.pagination?.total??data.pagination?.total_count);
      if(total!==undefined) {
        assert(Number.isInteger(Number(total))&&Number(total)>=0,'平台分页格式变化',502);
        assert(declaredTotal===undefined||declaredTotal===Number(total),'平台账号数在分页时发生变化，请重新同步',502);
        declaredTotal=Number(total);
      }
      if(totalPages!==undefined)assert(Number.isInteger(Number(totalPages))&&Number(totalPages)>=0,'平台分页格式变化',502);
      for(const a of items) {
        const email=this.provider==='gatelink'?(a.upstreamEmail||a.submittedEmail||a.email):(a.email||a.canonical_identity?.email);
        assert(email,'平台未返回可核实邮箱，本次同步未提交',502);
        const normalized=this.normalize(a);
        assert(!seen.has(normalized.id),'平台分页出现重复账号，本次同步未提交',502);
        assert(!emails.has(normalized.email),'平台同一邮箱对应多个账号，本次同步未提交',502);
        seen.add(normalized.id);emails.add(normalized.email);result.push(normalized);
      }
      if(totalPages!==undefined) {
        if(page>=Number(totalPages)) { assert(declaredTotal===undefined||result.length===declaredTotal,'平台账号结果不完整，本次同步未提交',502);return result; }
        assert(items.length>0,'平台分页提前结束',502);continue;
      }
      if(total!==undefined) { if(result.length>=Number(total)){assert(result.length===Number(total),'平台账号结果不完整，本次同步未提交',502);return result;}assert(items.length>0,'平台分页提前结束',502);continue; }
      if(items.length<100) return result;
    }
    throw new UpstreamError(0,'平台账号超过分页上限，本次同步未提交');
  }
  normalize(a:any):UpstreamAccount {
    if(this.provider==='minicc') {
      const email=a.canonical_identity?.email||a.email,daily=a.daily_cost;
      assert(a.upstream_id && email,'平台未返回账号 ID / 邮箱',502);
      upstreamAmount(daily,'平台未返回有效的当日用量，保留上次成功数据');
      return {id:String(a.upstream_id),email:String(email).toLowerCase(),name:a.name||email,status:a.status||'unknown',dailyUsd:String(daily),cost7d:a.cost_7d??null,cost30d:a.cost_30d??null,utilization:null,proxyExternalId:a.outbound_proxy_id?String(a.outbound_proxy_id):null,telemetry:normalizeTelemetry(this.provider,a)};
    }
    const gate=this.provider==='gatelink';
    const snapshot=gate?a.upstreamSnapshot:a;
    const email=(gate?(a.upstreamEmail||a.submittedEmail||a.email):(a.email||a.canonical_identity?.email))?.toLowerCase();
    assert(a.id && email,'平台未返回账号 ID / 邮箱',502);
    const daily=gate?a.upstreamDailyCost:a.stats?.daily_cost;
    // New Gatelink submissions can have an identity before any usage snapshot.
    // Keep that inventory row, with no dollar value to ingest. Malformed or
    // negative amounts still fail validation instead of silently disappearing.
    if(!gate || daily!==null&&daily!==undefined)upstreamAmount(daily,'平台未返回有效的当日用量，保留上次成功数据');
    return {id:String(a.id),email,name:a.name||email,status:gate?(a.upstreamStatus||a.status||'unknown'):(a.status||'unknown'),
      dailyUsd:daily===null||daily===undefined?null:String(daily),
      cost7d:(gate?a.upstreamCost7d:a.usage_windows?.cost_7d)??snapshot?.usage_windows?.cost_7d??null,
      cost30d:snapshot?.usage_windows?.cost_30d??null,
      utilization:(gate?a.upstreamUtilization5h:a.stats?.claude_utilization?.five_hour?.utilization)??null,
      telemetry:normalizeTelemetry(this.provider,a),
      ...(!gate?{proxyExternalId:a.outbound_proxy_id?String(a.outbound_proxy_id):null}:{})};
  }
  async enrichTelemetry(accounts:UpstreamAccount[]) {
    if(this.provider==='gatelink')return;
    // Optional operational reads are isolated per account. An unavailable
    // detail endpoint must not prevent inventory or financial synchronization.
    let index=0;
    const deadline=Date.now()+35000;
    // Rotate the starting account so a large pool still receives detail reads
    // over successive syncs when the optional read budget is exhausted.
    const offset=accounts.length?Math.floor(Date.now()/300000)%accounts.length:0;
    await Promise.all(Array.from({length:Math.min(4,accounts.length)},async()=>{
      while(index<accounts.length&&Date.now()<deadline) {
        const remote=accounts[(offset+index++)%accounts.length];
        try {
          const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(remote.id)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(remote.id)}`;
          const d=await this.call(path),a=d.account;
          assert(a&&String(a.upstream_id??a.id)===remote.id,'平台遥测账号身份不一致',502);
          const email=a.email??a.canonical_identity?.email;
          assert(!email||String(email).toLowerCase()===remote.email,'平台遥测账号邮箱不一致',502);
          const health=remote.telemetry?.health;
          const detailed=normalizeTelemetry(this.provider,{req_24h:health?.requests24h,ok_24h:health?.successful24h,limited_24h:health?.limited24h},d);
          const base=remote.telemetry;
          if(base) {
            for(const group of ['activity','limits','quota'] as const)for(const field of Object.keys(base[group])) {
              const values=detailed[group] as Record<string,any>;
              if(values[field]===null)values[field]=(base[group] as Record<string,any>)[field];
            }
            for(const p of telemetryPeriods)for(const field of ['requests','tokens','billedUsd','officialUsd','cacheCreditUsd'] as const) {
              if(detailed.periods[p][field]===null)(detailed.periods[p] as any)[field]=base.periods[p][field];
            }
          }
          remote.telemetry=detailed;
        }catch{/* Keep the safe account-list snapshot and its unavailable marker. */}
      }
    }));
    if(this.provider!=='ai008')return;
    for(let start=0;start<accounts.length&&Date.now()<deadline;start+=50) {
      const batch=accounts.slice(start,start+50);
      try {
        const d=await this.call(`/api/admin/oauth-accounts/model-usage?ids=${encodeURIComponent(batch.map(a=>a.id).join(','))}`);
        const generated=typeof d.generated_at==='string'?Date.parse(d.generated_at):NaN;
        // Keep the source timestamp even when the upstream model cache is
        // delayed. Current totals exclude it; the UI can show a dated reference.
        if(!Number.isFinite(generated)||generated>Date.now()+60000)continue;
        for(const a of batch)if(a.telemetry&&d.accounts?.[a.id])for(const p of telemetryPeriods) {
          a.telemetry.modelsAt=new Date(generated).toISOString();
          a.telemetry.periods[p].models=normalizeModelAmounts(d.accounts[a.id][{today:'today','5h':'five_hour','7d':'seven_day','30d':'thirty_day'}[p]]);
        }
      }catch{/* Model breakdown is optional; never use the shared summary. */}
    }
  }
  async options() {
    if(this.provider==='gatelink') {
      const settings=await this.call('/api/settings/submission');
      return {requireProxy:true,accountTypes:['speed','stable','team'],settings:{proxyMode:settings.proxyMode}};
    }
    if(this.provider==='minicc') {
      const {policy,template,groups}=await this.miniDefaults();
      return {requireProxy:true,accountTypes:[],configurationLocked:true,proxyMode:'manual',
        policies:[{id:policy.id,name:policy.name}],templates:[{id:template.id,name:template.name}],
        groups:groups.map((g:any)=>({id:g.id,name:g.name})),
        defaults:{policyTemplateId:policy.id,ccTemplateId:template.id,groupIds:groups.map((g:any)=>String(g.id))}};
    }
    const [groups,policies,templates]=await Promise.all([
      this.call('/api/admin/groups'),this.call('/api/admin/account-policy-templates'),this.call('/api/admin/cc-disguise-templates'),
    ]);
    const clean=(data:any,key:string)=>{
      const list=Array.isArray(data)?data:(data.items??data[key]??[]);
      return list.map((v:any)=>({id:v.id,name:v.name}));
    };
    return {requireProxy:true,accountTypes:['max','pro','team'],groups:clean(groups,'groups'),policies:clean(policies,'templates'),templates:clean(templates,'templates')};
  }
  private aiConfig(options:OAuthOptions) {
    this.requireProxy(options);
    return {provider:'anthropic',oauth_flow:'login',name:options.email,inference_backend:'native',
      ...(options.accountType?{account_type:options.accountType}:{}),
      outbound_proxy_mode:'manual',outbound_proxy_id:options.proxyExternalId,
      ...(options.policyTemplateId?{policy_template_id:options.policyTemplateId}:{}),
      ...(options.groupIds?.length?{group_ids:options.groupIds}:{}),
      ...(options.ccTemplateId?{cc_template_id:options.ccTemplateId}:{}),
    };
  }
  private requireProxy(options:OAuthOptions) {
    assert(options.proxy,'每个账号必须绑定专属出口代理');parseProxy(options.proxy);
    if(this.provider!=='gatelink')assert(options.proxyExternalId,'平台代理映射尚未确认，已阻止上号');
  }
  private proxyMatches(record:any,url:string,full:boolean) {
    const expected=parseProxy(url),raw=record.url??record.proxy_url??record.uri;
    if(typeof raw==='string') {try{return parseProxy(raw).url===expected.url;}catch{return false;}}
    const scheme=String(record.scheme||'').replace(/:$/,'').replace(/^socks5$/,'socks5h');
    if(scheme!==expected.scheme||String(record.host).toLowerCase()!==expected.host||Number(record.port)!==expected.port)return false;
    if(record.username!==undefined && String(record.username??'')!==expected.username)return false;
    if(record.password!==undefined && String(record.password??'')!==expected.password)return false;
    return !full||(Object.hasOwn(record,'username')&&Object.hasOwn(record,'password'));
  }
  private usableProxy(record:any,existing=false) {
    const full=record?.at_bound_account_limit===true;
    assert(record && record.status!=='disabled' && !record.missing && (record.selectable!==false||(existing&&full)) && (existing||!full),'平台代理已停用、失效或达到绑定上限，已阻止上号',502);
    const id=this.provider==='minicc'?(record.upstream_id??record.id):record.id;
    assert(typeof id==='string'&&id.length>0,'平台未返回有效的代理 ID',502);return id;
  }
  private async remoteProxies() {
    const result:any[]=[];
    for(let page=1;page<=1000;page++) {
      const path=this.provider==='minicc'?`/api/proxies/manage?page=${page}`:`/api/admin/outbound-proxies?page=${page}&limit=100`;
      const data=await this.call(path);
      assert(Array.isArray(data.proxies) && Number.isInteger(data.total) && data.total>=0,'平台代理列表格式变化',502);
      result.push(...data.proxies);
      if(result.length>=data.total) {
        const ids=result.map(p=>String(this.provider==='minicc'?(p.upstream_id??p.id):p.id));
        assert(result.length===data.total && new Set(ids).size===ids.length,'平台代理分页结果不完整或重复',502);return result;
      }
      assert(data.proxies.length>0,'平台代理分页不完整',502);
    }
    throw new UpstreamError(0,'平台代理分页超过上限');
  }
  async verifyProxyMapping(url:string,externalId:string) {
    const records=await this.remoteProxies();
    const record=records.find(p=>String(this.provider==='minicc'?(p.upstream_id??p.id):p.id)===externalId);
    assert(record && this.proxyMatches(record,url,false),'上游代理地址与账号固定代理不符或不可核实，已阻止上号',502);
    // Capacity limits apply to new assignments, not identity checks on a
    // proxy already occupied by this account. Upstream writes enforce capacity.
    return this.usableProxy(record,true);
  }
  async provisionProxy(url:string) {
    const normalized=parseProxy(url).url;
    if(this.provider==='gatelink')return null;
    const before=await this.remoteProxies();
    const exact=before.filter(p=>this.proxyMatches(p,normalized,true));
    assert(exact.length<=1,'上游出现重复代理，请管理员核对平台映射',502);
    if(exact.length===1)return this.usableProxy(exact[0]);
    const ids=new Set(before.map(p=>String(this.provider==='minicc'?(p.upstream_id??p.id):p.id)));
    const imported=await this.call(this.provider==='minicc'?'/api/proxies/import':'/api/admin/outbound-proxies/import','POST',{text:normalized});
    assert(!imported.failed && !(imported.errors?.length),'上游代理导入或连通测试失败，请在平台核对代理后重试',502);
    const after=await this.remoteProxies();
    const matches=after.filter(p=>this.proxyMatches(p,normalized,true));
    if(matches.length===1)return this.usableProxy(matches[0]);
    const fresh=after.filter(p=>!ids.has(String(this.provider==='minicc'?(p.upstream_id??p.id):p.id)));
    // A successful single import plus exactly one new matching record proves
    // provenance even when the upstream masks credentials in its read API.
    assert(Number(imported.imported)===1 && fresh.length===1 && this.proxyMatches(fresh[0],normalized,false),'上游代理已存在或导入结果不明确，请管理员核实平台映射后继续',502);
    return this.usableProxy(fresh[0]);
  }
  private async miniDefaults() {
    const meta=await this.call('/api/meta');
    const policy=meta.policyTemplates?.find((v:any)=>v.is_default===true),template=meta.ccTemplates?.find((v:any)=>v.is_default===true);
    assert(policy?.id && template?.id,'新平台缺少默认策略或 CC 模板，暂时无法上号',502);
    const groups=(meta.groups||[]).filter((v:any)=>policy.group_ids?.includes(v.id));
    assert(groups.length>0,'新平台默认策略没有可用分组，暂时无法上号',502);
    return {policy,template,groups};
  }
  private async miniConfig(options:OAuthOptions) {
    this.requireProxy(options);
    const {policy,template,groups}=await this.miniDefaults();
    const limits:Record<string,number>={};
    for(const field of ['max_rpm','max_tpm','max_concurrent','max_sessions']) {
      assert(typeof policy.policy?.[field]==='number' && Number.isFinite(policy.policy[field]) && policy.policy[field]>=0,'新平台默认策略限额格式变化',502);
      limits[field]=policy.policy[field];
    }
    // This upstream locks new accounts to its current default templates.
    return {name:options.email,inference_backend:'native',outbound_proxy_mode:'manual',outbound_proxy_id:options.proxyExternalId,
      overwrite_existing:false,cc_template_id:template.id,policy_template_id:policy.id,group_ids:groups.map((g:any)=>g.id),...limits};
  }
  private gatelinkConfig(options:OAuthOptions) {
    this.requireProxy(options);
    const accountType=options.accountType||'speed';
    assert(['speed','stable','team'].includes(accountType),'Gatelink 账号类型仅支持 speed、stable 或 team');
    // Gatelink documents SOCKS5 URLs. Keep the canonical account identity and
    // encrypted snapshot unchanged; serialize its SOCKS proxy in that API format.
    const proxy=parseProxy(options.proxy!).url.replace(/^socks5h:/,'socks5:');
    return {accountType,oauthFlow:'login',loginMethod:options.email,proxy};
  }
  async startOAuth(options:OAuthOptions) {
    this.requireProxy(options);
    if(this.provider==='gatelink') {
      const data=await this.call('/api/oauth-submissions/authorize','POST',{...this.gatelinkConfig(options),overwriteExisting:false});
      assert(data.authorizationUrl,'平台未返回授权地址',502);
      return {url:data.authorizationUrl,secret:{options},expiresIn:Math.min(data.expiresInSeconds||600,1800)};
    }
    if(this.provider==='minicc') {
      await this.miniDefaults();
      const data=await this.call('/api/accounts/auth-url','POST',{provider:'anthropic',oauth_flow:'login',name:options.email,inference_backend:'native',outbound_proxy_mode:'manual',outbound_proxy_id:options.proxyExternalId,overwrite_existing:false});
      assert(data.url && data.state,'平台未返回 OAuth URL / state',502);
      return {url:data.url,secret:{options,pendingState:data.state},expiresIn:600};
    }
    const data=await this.call('/api/admin/oauth-accounts/auth-url','POST',this.aiConfig(options));
    assert(data.url && data.state,'平台未返回 OAuth URL / state',502);
    return {url:data.url,secret:{options,pendingState:data.state},expiresIn:600};
  }
  async exchangeOAuth(secret:any,callback:string) {
    this.requireProxy(secret.options);
    if(this.provider==='gatelink') {
      const data=await this.call('/api/oauth-submissions/exchange','POST',{...this.gatelinkConfig(secret.options),callback:callback.trim()});
      assert(data.item,'平台未返回已提交账号',502);
      assert(data.item.upstreamEmail,'平台未返回可核实的真实邮箱，请由管理员同步核对归属',502);
      return this.normalize(data.item);
    }
    const code=statefulOAuthCallback(callback,secret.pendingState);
    if(this.provider==='minicc') {
      const data=await this.call('/api/accounts/exchange','POST',{...await this.miniConfig(secret.options),code,pending_state:secret.pendingState});
      assert(data.id,'平台未返回账号 ID',502);
      return this.submittedIdentity(data,secret.options.proxyExternalId);
    }
    const data=await this.call('/api/admin/oauth-accounts/exchange','POST',{...this.aiConfig(secret.options),code,pending_state:secret.pendingState});
    assert(data.id,'平台未返回账号 ID',502);
    return this.submittedIdentity(data,secret.options.proxyExternalId);
  }
  async importRefreshToken(options:OAuthOptions,refreshToken:string) {
    assert(PROVIDERS[this.provider].refreshTokenImport,'此平台不支持 refresh token 导入，需单独完成 OAuth 授权');
    if(this.provider==='minicc') {
      const data=await this.call('/api/accounts/import-rt','POST',{...await this.miniConfig(options),refresh_token:refreshToken});
      assert(data.id,'平台未返回账号 ID',502);
      return this.submittedIdentity(data,options.proxyExternalId);
    }
    const data=await this.call('/api/admin/oauth-accounts/import-rt','POST',{...this.aiConfig(options),refresh_token:refreshToken});
    assert(data.id,'平台未返回账号 ID',502);
    return this.submittedIdentity(data,options.proxyExternalId);
  }
  private async submittedIdentity(data:any,expectedProxyId:string|undefined):Promise<UpstreamAccount> {
    // The label supplied by the user is never proof of ownership. If the write
    // response omits the canonical email, verify it against the upstream list.
    const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(data.id)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(data.id)}`;
    const {account}=await this.call(path);
    assert(account,'平台未返回可验证的真实邮箱，请同步后由管理员核对归属',502);
    assert(String(account.outbound_proxy_id||'')===expectedProxyId,'上游实际绑定代理与账号固定代理不一致，请管理员核对',502);
    const email=account.canonical_identity?.email||account.email;
    if(!email) {
      const remote=(await this.listAccounts()).find(a=>a.id===String(data.id));
      assert(remote && remote.proxyExternalId===expectedProxyId,'平台未返回可验证的真实邮箱或一致的代理，请同步后由管理员核对归属',502);return remote;
    }
    return {id:String(data.id),email:String(email).toLowerCase(),name:String(email),status:account.status||'active',dailyUsd:'0',cost7d:null,cost30d:null,utilization:null,proxyExternalId:expectedProxyId};
  }
  async setEnabled(externalId:string,enabled:boolean) {
    if(this.provider==='gatelink') {
      assert(this.user?.role==='admin','Gatelink 启停账号需要上游管理员权限，当前主账号无此权限');
      return this.call(`/api/admin/accounts/${encodeURIComponent(externalId)}/enabled`,'POST',{enabled});
    }
    if(this.provider==='minicc') return this.call(`/api/accounts/${encodeURIComponent(externalId)}/status`,'POST',{status:enabled?'active':'disabled'});
    return this.call(`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`,'PATCH',{status:enabled?'active':'disabled'});
  }
  async setAccountProxy(externalId:string,options:OAuthOptions) {
    this.requireProxy(options);
    assert(this.provider!=='gatelink','Gatelink 当前权限不支持修改已有账号代理，请在上游修改后由管理员核实');
    if(this.provider==='minicc')await this.call(`/api/accounts/${encodeURIComponent(externalId)}/policy`,'POST',{outbound_proxy_id:options.proxyExternalId});
    else await this.call(`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`,'PATCH',{outbound_proxy_id:options.proxyExternalId});
    const path=this.provider==='minicc'?`/api/accounts/${encodeURIComponent(externalId)}/detail`:`/api/admin/oauth-accounts/${encodeURIComponent(externalId)}`;
    const {account}=await this.call(path);
    assert(account && String(account.outbound_proxy_id||'')===options.proxyExternalId,'上游实际代理未匹配，请核对后重试',502);
  }
  async historicalDay(day:string):Promise<{externalId:string;rawUsd:string}[]> {
    assert(PROVIDERS[this.provider].historicalUsage,'当前平台没有历史结算接口权限，请导入上游确认的日账单');
    if(this.provider==='minicc') {
      const query=new URLSearchParams({since:new Date(`${day}T00:00:00+08:00`).toISOString(),until:new Date(`${day}T23:59:59+08:00`).toISOString()});
      let data:any;
      for(let n=0;n<25;n++) {
        data=await this.call(`/api/usage?${query}`);
        assert(typeof data.complete==='boolean','历史用量完整性标记缺失，未写入账本',502);
        if(data.complete && !data.pending && !data.refreshing) break;
        if(n<24) await new Promise(resolve=>setTimeout(resolve,2000));
      }
      assert(data.complete && !data.pending && !data.refreshing,'历史查询尚未完成，请稍后重新查询',502);
      assert(Array.isArray(data.accounts),'上游历史结果缺少逐账号用量；未写入账本',502);
      return historicalRows(data.accounts);
    }
    const data=await this.call('/api/admin/vendor-usage/queries','POST',{since:`${day}T00:00:00+08:00`,until:`${day}T23:59:59+08:00`,granularity:'day'});
    assert(data.task?.id,'历史查询接口响应变化',502);
    const taskMatches=(task:any)=>task?.id===data.task.id
      &&(task.input?.since===undefined||Date.parse(task.input.since)===Date.parse(`${day}T00:00:00+08:00`))
      &&(task.input?.until===undefined||Date.parse(task.input.until)===Date.parse(`${day}T23:59:59+08:00`));
    let first:any;
    for(let n=0;n<25;n++) {
      first=await this.call(`/api/admin/vendor-usage/queries/${encodeURIComponent(data.task.id)}?page=1&account_page=1`);
      assert(taskMatches(first.task),'历史查询分页结果不完整',502);
      if(first.task?.status==='succeeded'||first.task?.status==='completed') break;
      assert(!['failed','cancelled'].includes(first.task?.status),'上游历史查询失败',502);
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    assert(first?.result && ['succeeded','completed'].includes(first.task?.status),'历史查询尚未完成，请稍后重新查询',502);
    const result=first.result;
    assert(Array.isArray(result.accounts),'上游历史结果缺少逐账号用量；未写入账本',502);
    const rows=[...result.accounts];
    const count=result.account_count,pageSize=result.page_size;
    assert(Number.isInteger(count)&&count>=0&&count<=100000&&Number.isInteger(pageSize)&&pageSize>=0&&(pageSize>0||count===0)
      &&(count===0||Math.ceil(count/pageSize)<=1000)&&result.account_page===1,'历史查询分页格式变化',502);
    for(let page=2;page<=Math.ceil(count/pageSize);page++) {
      const next=await this.call(`/api/admin/vendor-usage/queries/${encodeURIComponent(data.task.id)}?page=1&account_page=${page}`);
      assert(taskMatches(next.task)&&['succeeded','completed'].includes(next.task?.status)&&Array.isArray(next.result?.accounts)
        &&next.result.account_count===count&&next.result.page_size===pageSize&&next.result.account_page===page,'历史查询分页结果不完整',502);
      rows.push(...next.result.accounts);
    }
    assert(rows.length===count,'历史账号结果不完整，未写入账本',502);
    return historicalRows(rows);
  }
}
