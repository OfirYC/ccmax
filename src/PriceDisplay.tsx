import { useState } from 'react';
import { money } from './api';
import { Field } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';

type AmountTone='neutral'|'settlement'|'profit'|'pending';

export function Amount({value,digits=4,tone='neutral',signed=false}:{value:any;digits?:number;tone?:AmountTone;signed?:boolean}) {
  useLocale();
  const missing=value===null||value===undefined;
  return <span className={`amount amount-${tone}${missing?' amount-missing':Number(value)<0?' amount-negative':''}`}>{missing?'—':`${signed&&Number(value)>0?'+':''}${money(value,digits)}`}</span>;
}

export function RateBadge({value}:{value:any}) {
  useLocale();
  const missing=value===null||value===undefined;
  return <span className={`rate-value${missing?' rate-missing':''}`}>{missing?t('未定价'):`× ${Number(value).toFixed(4)}`}</span>;
}

export function RateField({name,label,defaultValue,hint,recipient='settlement',max=1}:{name:string;label:string;defaultValue?:any;hint?:string;recipient?:'self'|'downstream'|'settlement';max?:number}) {
  useLocale();
  const [value,setValue]=useState(defaultValue===undefined||defaultValue===null?'':String(defaultValue));
  const valid=value.trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=max;
  const example=recipient==='self'?t('平台账单 $100 · 我的应收示例'):recipient==='downstream'?t('平台账单 $100 · 下级应收示例'):t('平台账单 $100 · 结算金额示例');
  return <div className="price-field">
    <Field label={label} hint={hint}><input className="rate-input" name={name} aria-label={label} type="number" min="0" max={max} step="0.0001" required placeholder={Math.min(0.1,max).toFixed(4)} value={value} onChange={e=>setValue(e.target.value)}/></Field>
    <div className="rate-preview" aria-live="polite"><span>{example}</span>{valid?<Amount value={Number(value)*100} digits={2} tone="settlement"/>:<span className="rate-preview-empty">{t('输入 0–{0} 的折扣',[max.toFixed(4)])}</span>}</div>
  </div>;
}
