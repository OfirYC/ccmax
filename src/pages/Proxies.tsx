import { t } from '../i18n';
import { useLocale } from '../LanguageSwitcher';
import { useState } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';
import { mutate, post, useData } from '../api';
import { Badge, Empty, ErrorBox, Field, Form, Loading, Modal, PageHead, Submit, Table, useToast } from '../components';

export default function Proxies() {
  useLocale();
  const toast=useToast(),{data,error,loading,refresh}=useData('/api/proxies'),[adding,setAdding]=useState(false);
  return <>
    <PageHead eyebrow={t('账号出口代理')} title={t('出口代理')} description={t('只显示你自己的代理。每个 Claude 账号绑定一次，所有平台自动沿用。')}
      actions={<button className="button primary" onClick={()=>setAdding(true)}><Plus size={16}/>{t('添加代理')}</button>}/>
    <ErrorBox error={error}/>
    <div className="notice"><ShieldCheck size={18}/><span>{t('代理认证信息加密保存。账号绑定后不可直接替换；禁止上号会阻止该代理的新授权、RT 导入及账号启用，不会修改既有账单。')}</span></div>
    <section className="panel">{loading?<Loading/>:data?.proxies.length?<Table headers={[t('代理名称 / 出口'),t('固定账号'),t('允许上号'),t('操作')]}>
      {data.proxies.map((proxy:any)=><tr key={proxy.id}>
        <td><strong>{proxy.name}</strong><small className="mono">{proxy.endpoint}</small></td>
        <td>{proxy.account_email||<span className="muted">{t('未占用')}</span>}</td>
        <td><Badge state={proxy.enabled?'active':'disabled'}/></td>
        <td><div className="row-actions"><button onClick={async()=>{try{await mutate(`/api/proxies/${proxy.id}`,'PATCH',{enabled:!proxy.enabled});await refresh();}catch(error){toast((error as Error).message,'error');}}}>{proxy.enabled?t('禁止上号'):t('允许上号')}</button></div></td>
      </tr>)}
    </Table>:<Empty title={t('先添加账号专属代理')} detail={t('上号前必须添加并绑定代理，系统不会自动分配其他出口或改为直连。')}/>}</section>
    {adding&&<Modal title={t('添加出口代理')} onClose={()=>setAdding(false)}><Form onSubmit={async form=>{
      await post('/api/proxies',{name:form.get('name'),url:form.get('url')});toast(t('代理已加密保存，可在账号上号时绑定'));setAdding(false);await refresh();
    }}>
      <Field label={t('代理名称')}><input name="name" required maxLength={80}/></Field>
      <Field label={t('代理地址')} hint={t('支持 http、https、socks5h URL；socks5 统一转换为 socks5h。')}><input aria-label={t('代理地址')} name="url" type="password" required maxLength={2000} autoComplete="new-password" placeholder="http://user:password@host:port"/></Field>
      <Submit>{t('保存代理')}</Submit>
    </Form></Modal>}
  </>;
}
