import { useEffect, useRef, useState } from 'react';
import { dateTime, key, post, useData } from './api';
import { Badge, ErrorBox, Field, Modal, PlatformMark, useSession } from './components';
import { RateBadge } from './PriceDisplay';
import { t, translateMessage } from './i18n';
import { useLocale } from './LanguageSwitcher';

export default function AccountPlatformManager({account,onClose,onOnboard,onConfirmProxy,onRefresh}:{
  account:any;onClose:()=>void;onOnboard:(account:any,connectionId:string,bindingId?:string)=>void;
  onConfirmProxy:(binding:any)=>void;onRefresh:()=>void;
}) {
  useLocale();
  const {user}=useSession(),accounts=useData('/api/accounts',5000),connections=useData('/api/connections'),jobs=useData('/api/jobs',1800);
  const current=accounts.data?.accounts.find((value:any)=>value.id===account.id)||account;
  const [error,setError]=useState(''),[busy,setBusy]=useState(''),[submitted,setSubmitted]=useState<Record<string,any>>({});
  const [editing,setEditing]=useState(''),[enabled,setEnabled]=useState('active');
  const completed=useRef(new Set<string>());
  useEffect(()=>{
    const finished=Object.values(submitted).map(job=>jobs.data?.jobs.find((value:any)=>value.id===job.id))
      .filter(job=>job&&!['queued','running'].includes(job.state)&&!completed.current.has(job.id));
    if(!finished.length)return;
    finished.forEach(job=>completed.current.add(job.id));
    void accounts.refresh();onRefresh();
  },[jobs.data,submitted]);
  const own=current.owner_id===user.id,canManage=own&&current.ownership_verified||user.role==='owner';
  const list=(connections.data?.connections||[]).filter((connection:any)=>connection.enabled||current.bindings.some((binding:any)=>binding.connection_id===connection.id));
  async function submit(connection:any,binding:any,action:'proxy'|'status',value?:boolean) {
    setError('');setBusy(connection.id);
    try {
      const job=await post(`/api/bindings/${binding.id}/${action==='proxy'?'proxy/sync':'status'}`,{key:key(),...(action==='status'?{enabled:value}:{})});
      setSubmitted(previous=>({...previous,[connection.id]:job}));setEditing('');void jobs.refresh();
    } catch(error) {setError(`${connection.capabilities.name}: ${translateMessage((error as Error).message)}`);}
    finally {setBusy('');}
  }
  return <Modal title={t('平台账号管理')} subtitle={current.email} wide onClose={onClose}>
    <ErrorBox error={error||accounts.error||connections.error}/>
    <div className="notice">{t('每个平台可单独管理。重新授权会更新原平台账号的登录凭据，保留归属、对账绑定和历史账单。')}</div>
    {!current.proxy_id&&<p className="notice amber">{t('请先为该账号绑定并启用专属出口代理')}</p>}
    <div className="account-platforms">{list.map((connection:any)=>{
      const binding=current.bindings.find((value:any)=>value.connection_id===connection.id);
      const name=connection.capabilities.name,job=submitted[connection.id]&&(jobs.data?.jobs.find((value:any)=>value.id===submitted[connection.id].id)||submitted[connection.id]);
      const pending=busy===connection.id||job&&['queued','running'].includes(job.state);
      const proxyReady=!!current.proxy_id&&current.proxy_enabled;
      return <section className="account-platform-card" key={connection.id} aria-label={name}>
        <div className="account-platform-head"><PlatformMark provider={connection.provider}/><strong>{name}</strong><Badge state={binding?.status||'pending'} label={binding?undefined:t('未接入')}/></div>
        <div className="account-platform-price"><span>{t('我的结算折扣')}</span><RateBadge value={connection.settlement_rate}/><small>{t('平台账单 × 此折扣 = 我的应收美元')}</small></div>
        {connection.upcoming_settlement_rate!==null&&connection.upcoming_settlement_rate!==undefined&&<p className="form-hint">{t('待生效')} <RateBadge value={connection.upcoming_settlement_rate}/> · {connection.upcoming_settlement_date}</p>}
        {binding?<>
          <p className="account-platform-proxy">{binding.proxy_id===current.proxy_id&&proxyReady?t('固定代理已核实'):t('代理待核对')} · {current.proxy_name||t('未绑定代理')}</p>
          <small>{t('最近同步')} {dateTime(binding.snapshot_at||binding.last_seen_at)}</small>
          <details className="account-platform-ids"><summary>{t('对账信息')}</summary><small>{t('上游账号 ID：')}{binding.external_id}</small><small>{t('对账绑定 ID：')}{binding.id}</small></details>
          <div className="account-platform-actions">
            {canManage&&connection.enabled&&<>
              {connection.provider!=='gatelink'?<button className="button" disabled={!proxyReady||!!pending} onClick={()=>submit(connection,binding,'proxy')}>{t('同步固定代理')}</button>
                :user.role==='owner'?<button className="button" disabled={!proxyReady||!!pending} onClick={()=>onConfirmProxy(binding)}>{t('核实已有代理')}</button>:null}
              <button className="button" disabled={!!pending} onClick={()=>submit(connection,binding,'status',binding.status!=='active')}>{binding.status==='active'?t('停用'):t('启用')}</button>
              <button className="button" disabled={!!pending} onClick={()=>{setEditing(binding.id);setEnabled(binding.status==='disabled'?'disabled':'active');}}>{t('编辑状态')}</button>
            </>}
            {own&&current.ownership_verified&&connection.enabled&&<button className="button primary" disabled={!proxyReady||!!pending} onClick={()=>onOnboard(current,connection.id,binding.id)}>{t('重新授权')}</button>}
          </div>
          {editing===binding.id&&<div className="account-platform-editor"><Field label={t('{0} 目标状态',[name])}><select value={enabled} onChange={event=>setEnabled(event.target.value)}><option value="active">{t('启用')}</option><option value="disabled">{t('停用')}</option></select></Field><button className="button primary" disabled={!!pending} onClick={()=>submit(connection,binding,'status',enabled==='active')}>{t('保存状态')}</button><button className="button" onClick={()=>setEditing('')}>{t('取消')}</button></div>}
          {connection.provider==='gatelink'&&<p className="form-hint">{t('Gatelink 启停需要上游管理员权限；权限不足时会显示原因，可通过重新授权修复登录凭据。')}</p>}
        </>:<div className="account-platform-actions">{own&&connection.enabled&&<button className="button primary" disabled={!proxyReady} onClick={()=>onOnboard(current,connection.id)}>{t('上号到此平台')}</button>}</div>}
        {job&&<div className="account-platform-job"><Badge state={job.state}/><small>{t('任务编号：')}{job.id}</small>{job.error&&<p className="error-text">{translateMessage(job.error)}</p>}{job.state==='succeeded'&&<p className="teal-text">{t('操作已完成，账号状态已重新读取。')}</p>}{job.state==='needs_attention'&&<p className="form-hint">{t('操作结果需要核对，请刷新账号状态后再决定是否重试。')}</p>}</div>}
      </section>;
    })}</div>
    <div className="modal-actions"><button className="button" onClick={async()=>{await accounts.refresh();onRefresh();}}>{t('刷新账号状态')}</button><button className="button" onClick={onClose}>{t('关闭')}</button></div>
  </Modal>;
}
