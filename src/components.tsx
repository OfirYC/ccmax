import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { AlertCircle, ArrowUpRight, Check, ChevronLeft, ChevronRight, Inbox, Loader2, X } from 'lucide-react';
import { api, type RecordData } from './api';

export const SessionContext=createContext<{user:RecordData;reload:()=>Promise<void>}>({user:{},reload:async()=>{}});
export const useSession=()=>useContext(SessionContext);
type Toast=(message:string,tone?:'success'|'error')=>void;
export const ToastContext=createContext<Toast>(()=>{});
export const useToast=()=>useContext(ToastContext);
export function Toasts({children}:{children:ReactNode}) {
  const [items,setItems]=useState<{id:number;message:string;tone:string}[]>([]);
  const notify:Toast=(message,tone='success')=>{const id=Date.now()+Math.random();setItems(v=>[...v,{id,message,tone}]);setTimeout(()=>setItems(v=>v.filter(t=>t.id!==id)),6000);};
  return <ToastContext.Provider value={notify}>{children}<div className="toast-stack" role="status" aria-live="polite">{items.map(t=><div className={`toast ${t.tone}`} key={t.id}>{t.tone==='error'?<AlertCircle size={17}/>:<Check size={17}/>}<span>{t.message}</span><button className="icon-button" aria-label="关闭通知" onClick={()=>setItems(v=>v.filter(i=>i.id!==t.id))}><X size={14}/></button></div>)}</div></ToastContext.Provider>;
}
export function Modal({title,subtitle,children,onClose,wide=false}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
  const ref=useRef<HTMLDivElement>(null),old=useRef<HTMLElement|null>(null);
  useEffect(()=>{old.current=document.activeElement as HTMLElement;const before=document.body.style.overflow;document.body.style.overflow='hidden';ref.current?.focus();const listen=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();if(e.key==='Tab'){const elements=ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea,a[href]');if(!elements?.length)return;const first=elements[0],last=elements[elements.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};window.addEventListener('keydown',listen);return()=>{window.removeEventListener('keydown',listen);document.body.style.overflow=before;old.current?.focus();};},[]);
  return <div className="modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={`modal ${wide?'wide':''}`} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={20}/></button></div><div className="modal-body">{children}</div></div></div>;
}
export function Field({label,hint,children}:{label:string;hint?:string;children:ReactNode}) { return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>; }
export function Submit({children,busy=false}:{children:ReactNode;busy?:boolean}) {return <button className="button primary" type="submit" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Check size={16}/>} {children}</button>;}
export function Empty({title='暂无数据',detail,action}:{title?:string;detail?:string;action?:ReactNode}) {return <div className="empty"><div className="empty-icon"><Inbox size={25}/></div><h3>{title}</h3>{detail&&<p>{detail}</p>}{action}</div>;}
export function ErrorBox({error}:{error?:string}) {return error?<div className="error-box" role="alert"><AlertCircle size={17}/><span>{error}</span></div>:null;}
export function Loading(){return <div className="loading"><Loader2 size={22} className="spin"/>正在读取工作台…</div>;}
const states:Record<string,[string,string]>={active:['正常','green'],healthy:['健康','green'],connected:['已连接','green'],pending:['待处理','amber'],provisional:['实时预估','amber'],final:['已核实','green'],confirmed:['已确认','green'],succeeded:['已完成','green'],failed:['失败','red'],needs_attention:['需要核对','amber'],error:['连接异常','red'],disabled:['已停用','gray'],queued:['排队中','gray'],running:['执行中','blue'],paid:['已打款','green'],rejected:['已驳回','red'],unknown:['待核对','gray'],'已入库':['已入库','green']};
export function Badge({state,label}:{state:string;label?:string}) {const [text,color]=states[state]||[state,'gray'];return <span className={`badge ${color}`}><i/>{label||text}</span>;}
export function PlatformMark({provider,size='normal'}:{provider:string;size?:string}) {return <span className={`platform-mark ${provider} ${size}`}>{provider==='ai008'?'a':'G'}<span>{provider==='ai008'?'✳':'↗'}</span></span>;}
export function PageHead({eyebrow,title,description,actions}:{eyebrow:string;title:string;description:string;actions?:ReactNode}) {return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="actions">{actions}</div></div>;}
export function Table({headers,children}:{headers:string[];children:ReactNode}) {return <div className="table-scroll"><table><thead><tr>{headers.map((h,i)=><th key={`${h}${i}`}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;}
export function Paginator({total,page,setPage,size=12}:{total:number;page:number;setPage:(n:number)=>void;size?:number}) {const count=Math.max(1,Math.ceil(total/size));useEffect(()=>{if(page>count)setPage(count);},[count,page,setPage]);return <div className="paginator"><span>共 {total} 条记录</span><div><button className="icon-button" aria-label="上一页" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft size={16}/></button><span>{page} / {count}</span><button className="icon-button" aria-label="下一页" disabled={page>=count} onClick={()=>setPage(page+1)}><ChevronRight size={16}/></button></div></div>;}
export function Form({onSubmit,children}:{onSubmit:(data:FormData)=>Promise<void>;children:ReactNode}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(busy)return;const data=new FormData(e.currentTarget);setBusy(true);setError('');try{await onSubmit(data);}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  return <form onSubmit={submit}><fieldset disabled={busy}><ErrorBox error={error}/>{children}</fieldset>{busy&&<div className="form-busy"><Loader2 size={14} className="spin"/>正在保存…</div>}</form>;
}
export function ExportButton({href,children}:{href:string;children:ReactNode}) {return <a className="button" href={href} download>{children}<ArrowUpRight size={14}/></a>;}
