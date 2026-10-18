import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useData } from './api';
import { Field, Form, Submit, useSession } from './components';

export default function ProxySetup({account,onChange}:{account:any;onChange:(account:any)=>void}) {useLocale();
  const {user}=useSession(),{data,refresh}=useData('/api/proxies'),[adding,setAdding]=useState(false);
  const free=(data?.proxies||[]).filter((p:any)=>p.enabled&&(!p.account_id||p.account_id===account.id)&&(p.owner_id===user.id||(user.role==='owner'&&p.owner_id===account.owner_id)));
  async function bind(proxyId:string) {
    const result=await post(`/api/accounts/${account.id}/proxy`,{proxyId});onChange({...account,...result.account});await refresh();
  }
  if(account.proxy_id)return <div className={`notice ${account.proxy_enabled===false?'amber':''}`}><span><strong>{t("固定出口代理：")}{account.proxy_name||t("已绑定")}</strong><br/>{account.proxy_endpoint} · {account.proxy_enabled===false?t("已禁止上号，请启用此代理"):t("所有平台统一使用此代理")}<br/><small>{t("账号固定绑定后不可直接替换。")}<Link to="/proxies">{t("管理代理")}</Link></small></span></div>;
  return <section className="proxy-setup"><h3>{t("先绑定账号专属代理")}</h3><p className="form-hint">{t("一个账号固定使用一条代理，上到任何平台都保持一致；不同账号不能重复占用同一条代理。")}</p>{!adding?<Form onSubmit={async f=>bind(String(f.get('proxyId')))}><Field label={t("账号固定代理")}><select aria-label={t("账号固定代理")} name="proxyId" required><option value="">{t("选择未占用的代理")}</option>{free.map((p:any)=><option value={p.id} key={p.id}>{p.name} · {p.endpoint}</option>)}</select></Field><div className="actions"><Submit>{t("绑定所选代理")}</Submit><button type="button" className="button" onClick={()=>setAdding(true)}>{t("添加新代理")}</button></div></Form>:<Form onSubmit={async f=>{const p=await post('/api/proxies',{name:f.get('name'),url:f.get('url')});await bind(p.id);}}><Field label={t("代理名称")}><input name="name" required maxLength={80} placeholder={t("例如：账号专属出口 01")}/></Field><Field label={t("代理地址")} hint={t("支持 http://用户:密码@主机:端口、https 或 socks5h。认证信息加密保存。")}><input aria-label={t("代理地址")} name="url" type="password" required maxLength={2000} autoComplete="new-password" placeholder="http://user:password@host:port"/></Field><div className="actions"><Submit>{t("添加并绑定代理")}</Submit><button className="button" type="button" onClick={()=>setAdding(false)}>{t("选择已有代理")}</button></div></Form>}</section>;
}
