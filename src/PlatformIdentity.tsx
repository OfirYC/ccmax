import { createContext, useContext, type ReactNode } from 'react';
import { platformName } from '../shared/platforms';
import { useData } from './api';
import { PlatformMark } from './components';
import { RateBadge } from './PriceDisplay';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';

type CatalogData={data:any;error:string;loading:boolean;refresh:()=>Promise<void>};
const Catalog=createContext<CatalogData>({data:null,error:'',loading:true,refresh:async()=>{}});
export const usePlatformCatalog=()=>useContext(Catalog);

// One catalog per authenticated workspace, shared by table cells and dialogs.
export function PlatformCatalog({children}:{children:ReactNode}) {
  const catalog=useData('/api/connections',30000);
  return <Catalog.Provider value={catalog}>{children}</Catalog.Provider>;
}

export function platformOptionLabel(connection:any) {
  const value=connection.settlement_rate;
  return `${platformName(connection.provider)} · ${t('我的结算折扣')} ${value===null||value===undefined?t('未定价'):`× ${Number(value).toFixed(4)}`} · ${connection.id.slice(0,8)}`;
}

export function PlatformIdentity({provider,connectionId,rate,rates,historical=false,showMark=true,showPrice=true,showId=false,showName=true}:{
  provider?:string;connectionId?:string;rate?:string|number|null;rates?:(string|number)[];historical?:boolean;showMark?:boolean;showPrice?:boolean;showId?:boolean;showName?:boolean;
}) {
  useLocale();
  const catalog=usePlatformCatalog(),connection=(catalog.data?.connections||[]).find((connection:any)=>connection.id===connectionId);
  const kind=provider||connection?.provider||'',name=platformName(kind);
  const values=rates?.length?rates:[historical?rate:rate===undefined?connection?.settlement_rate:rate];
  const label=historical?t('账单冻结折扣'):t('当前结算折扣');
  return <span className="platform-identity">
    {showMark&&<PlatformMark provider={kind} size="tiny"/>}
    {showName&&<span className="platform-public-name">{name}</span>}
    {showPrice&&<span className="platform-identity-price" title={label} aria-label={label}>
      <small>{label}</small>{values.map((value,index)=>(historical&&(value===null||value===undefined)||!historical&&rate===undefined&&!catalog.data)
        ?<span key={index} className="rate-value rate-missing">—</span>:<RateBadge key={index} value={value}/>)}
    </span>}
    {showId&&connectionId&&<small className="platform-connection-id">{connectionId.slice(0,8)}</small>}
  </span>;
}
