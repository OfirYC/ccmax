import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { key, mutate, post, useData } from './api';
import { ErrorBox, Field, Form, Submit, useSession } from './components';

export default function ProxySetup({account,onChange}:{account:any;onChange:(account:any)=>void}) {
  useLocale();
  const {user}=useSession(),{data,error:loadError,refresh}=useData('/api/proxies');
  const [adding,setAdding]=useState(false),[changing,setChanging]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[submitted,setSubmitted]=useState(false);
  const own=account.owner_id===user.id,hasProxy=account.proxy_bound??!!account.proxy_id;
  const proxies=(data?.proxies||[]).filter((proxy:any)=>proxy.owner_id===user.id);
  const bound=proxies.find((proxy:any)=>proxy.id===account.proxy_id),enabled=account.proxy_enabled??bound?.enabled;
  const needsSync=account.proxy_sync_state?account.proxy_sync_state!=='succeeded':(account.bindings||[]).some((binding:any)=>binding.provider!=='A'&&!(binding.proxy_verified??binding.proxy_id===account.proxy_id));
  const syncing=['queued','running'].includes(account.proxy_sync_state);
  async function bind(proxyId:string) {
    const result=await post(`/api/accounts/${account.id}/proxy`,{proxyId});
    onChange({...account,...result.account});setChanging(false);setAdding(false);setSubmitted(!!result.jobs?.length||!!result.reauthorizeConnectionIds?.length);await refresh();
  }
  async function enable() {
    setBusy(true);setError('');
    try {await mutate(`/api/proxies/${account.proxy_id}`,'PATCH',{enabled:true});onChange({...account,proxy_enabled:true});await sync();await refresh();}
    catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  async function sync() {
    if(!account.ownership_verified)return;
    const result=await post(`/api/accounts/${account.id}/proxy/sync`,{key:key()});
    setSubmitted(!!result.jobs?.length);onChange(account);
  }
  if(hasProxy)return <>
    <ErrorBox error={error||account.proxy_sync_error||(own?loadError:'')}/>
    <div className={`notice ${enabled===false?'amber':''}`}><span>
      <strong>{t('固定出口代理：')}{own?(bound?.name||account.proxy_name||t('已绑定')):t('已绑定')}</strong>
      {own&&<><br/>{bound?.endpoint||account.proxy_endpoint}</>}
      <br/>{enabled===false?t('已禁止上号，请启用此代理'):t('所有平台自动沿用这条代理。')}
      {own&&<><br/><small>{t('账号归属核实后可更换代理，历史账单和平台绑定会保留。')} <Link to="/proxies">{t('管理代理')}</Link></small></>}
      {own&&enabled===false&&<button type="button" className="button" disabled={busy} onClick={enable}>{t('允许上号')}</button>}
      {own&&account.ownership_verified&&<button type="button" className="button" disabled={busy} onClick={()=>{setChanging(value=>!value);setAdding(false);setError('');}}>{changing?t('取消更换'):t('更换代理')}</button>}
      {enabled!==false&&needsSync&&account.ownership_verified&&(own||user.role==='owner')&&<button type="button" className="button" disabled={busy||syncing} onClick={async()=>{setBusy(true);setError('');try{await sync();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}}>{t('检查并同步账号代理')}</button>}
      {(submitted||syncing)&&needsSync&&<small>{t('账号代理同步已提交，系统会统一处理支持的平台。')}</small>}
    </span></div>
    {changing&&<ProxyPicker proxies={proxies} account={account} onSubmit={bind} onAdd={()=>setAdding(true)} adding={adding} onCancel={()=>{setChanging(false);setAdding(false);}}/>}
  </>;
  if(!own)return <p className="notice amber">{t('请账号所属成员绑定自己的专属代理，绑定后所有平台自动沿用。')}</p>;
  return <section className="proxy-setup"><ErrorBox error={loadError}/><h3>{t('先绑定账号专属代理')}</h3>
    <p className="form-hint">{t('只能选择自己的代理；一个账号绑定一条代理，所有平台自动沿用，无需重复绑定。')}</p>
    {!adding?<Form onSubmit={async form=>bind(String(form.get('proxyId')))}>
      <Field label={t('账号固定代理')}><select aria-label={t('账号固定代理')} name="proxyId" required>
        <option value="">{t('选择未占用的代理')}</option>
        {proxies.map((proxy:any)=><option value={proxy.id} key={proxy.id} disabled={!proxy.enabled||!!proxy.account_id&&proxy.account_id!==account.id}>
          {proxy.name} · {proxy.endpoint}{proxy.account_id&&proxy.account_id!==account.id?` · ${t('已占用：{0}',[proxy.account_email])}`:proxy.enabled?'':` · ${t('禁止上号')}`}
        </option>)}
      </select></Field>
      <div className="actions"><Submit>{t('绑定所选代理')}</Submit><button type="button" className="button" onClick={()=>setAdding(true)}>{t('添加新代理')}</button></div>
    </Form>:<Form onSubmit={async form=>{const proxy=await post('/api/proxies',{name:form.get('name'),url:form.get('url')});await bind(proxy.id);}}>
      <Field label={t('代理名称')}><input name="name" required maxLength={80} placeholder={t('例如：账号专属出口 01')}/></Field>
      <Field label={t('代理地址')} hint={t('支持 http://用户:密码@主机:端口、https 或 socks5h。认证信息加密保存。')}>
        <input aria-label={t('代理地址')} name="url" type="password" required maxLength={2000} autoComplete="new-password" placeholder="http://user:password@host:port"/>
      </Field>
      <div className="actions"><Submit>{t('添加并绑定代理')}</Submit><button className="button" type="button" onClick={()=>setAdding(false)}>{t('选择已有代理')}</button></div>
    </Form>}
  </section>;
}

function ProxyPicker({proxies,account,onSubmit,onAdd,adding,onCancel}:{proxies:any[];account:any;onSubmit:(proxyId:string)=>Promise<void>;onAdd:()=>void;adding:boolean;onCancel:()=>void}) {
  const {t:translate}=useProxyText();
  if(adding)return <section className="proxy-setup proxy-rotate-form"><Form onSubmit={async form=>{const proxy=await post('/api/proxies',{name:form.get('name'),url:form.get('url')});await onSubmit(proxy.id);}}>
    <Field label={translate('代理名称')}><input name="name" required maxLength={80} placeholder={translate('例如：账号专属出口 01')}/></Field>
    <Field label={translate('代理地址')} hint={translate('支持 http://用户:密码@主机:端口、https 或 socks5h。认证信息加密保存。')}>
      <input aria-label={translate('代理地址')} name="url" type="password" required maxLength={2000} autoComplete="new-password" placeholder="http://user:password@host:port"/>
    </Field>
    <div className="actions"><Submit>{translate('添加并更换代理')}</Submit><button className="button" type="button" onClick={onCancel}>{translate('取消')}</button></div>
  </Form></section>;
  return <section className="proxy-setup proxy-rotate-form"><Form onSubmit={async form=>onSubmit(String(form.get('proxyId')))}>
    <Field label={translate('新的账号固定代理')}><select aria-label={translate('新的账号固定代理')} name="proxyId" required defaultValue="">
      <option value="">{translate('选择未占用的代理')}</option>
      {proxies.map((proxy:any)=><option value={proxy.id} key={proxy.id} disabled={!proxy.enabled||proxy.id===account.proxy_id||!!proxy.account_id&&proxy.account_id!==account.id}>
        {proxy.name} · {proxy.endpoint}{proxy.id===account.proxy_id?` · ${translate('当前使用')}`:proxy.account_id&&proxy.account_id!==account.id?` · ${translate('已占用：{0}',[proxy.account_email])}`:proxy.enabled?'':` · ${translate('禁止上号')}`}
      </option>)}
    </select></Field>
    <div className="actions"><Submit>{translate('更换为所选代理')}</Submit><button type="button" className="button" onClick={onAdd}>{translate('添加新代理')}</button><button type="button" className="button" onClick={onCancel}>{translate('取消')}</button></div>
  </Form></section>;
}

// Keep the picker independent from the parent hook so the existing setup and
// rotation forms share the same localized labels without changing their API.
function useProxyText(){
  useLocale();
  return {t};
}
