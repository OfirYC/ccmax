import { t, getLocale } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
export type RecordData=Record<string,any>;
export class ApiError extends Error {
  constructor(message:string,public status:number,public code?:string){super(message);}
}
export async function api<T=any>(url:string,options:RequestInit={}) : Promise<T> {
  const response=await fetch(url,{...options,headers:{...(options.body!==undefined?{'Content-Type':'application/json'}:{}),'x-ccmax-request':'1',...options.headers},credentials:'same-origin'});
  const data=await response.json().catch(()=>({error:t("服务器响应异常")}));
  if(!response.ok) throw new ApiError(data.error||t("请求失败"),response.status,data.code);return data;
}
export const post=<T=any>(url:string,body:unknown)=>api<T>(url,{method:'POST',body:JSON.stringify(body)});
export const mutate=(url:string,method:string,body:unknown)=>api(url,{method,body:JSON.stringify(body)});
export function useData<T=any>(url:string,poll=0) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const generation=useRef(0),currentUrl=useRef(url);currentUrl.current=url;
  const refresh=useCallback(async()=>{
    const request=++generation.current,active=()=>request===generation.current&&currentUrl.current===url;
    try{const d=await api<T>(url);if(active()){setData(d);setError('');}}
    catch(e){if(active())setError((e as Error).message);}
    finally{if(active())setLoading(false);}
  },[url]);
  useEffect(()=>{setLoading(true);void refresh();const timer=poll?setInterval(refresh,poll):null;return()=>{generation.current++;if(timer)clearInterval(timer);};},[url,poll,refresh]);
  return {data,error,loading,refresh};
}
export const money=(n:any,digits=2)=>new Intl.NumberFormat(getLocale()==='zh-CN'?'en-US':getLocale(),{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n||0);
export const number=(n:any)=>Number(n||0).toLocaleString(getLocale());
export const dateTime=(v:any)=>v?new Date(v).toLocaleString(getLocale(),{timeZone:'Asia/Shanghai',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):t("尚未同步");
export const day=(v:any)=>String(v||'').slice(0,10);
export const localToday=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export const yesterday=()=>new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
export const key=()=>crypto.randomUUID();
