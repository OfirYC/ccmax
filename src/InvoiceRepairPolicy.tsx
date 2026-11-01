import { useState } from 'react';
import { post, useData } from './api';
import { ErrorBox, Form, Modal, Submit, useToast } from './components';
import { useLocale } from './LanguageSwitcher';
import { t } from './i18n';

export function InvoiceRepairPolicy({onChange}:{onChange:()=>Promise<unknown>}) {
  useLocale();
  const {data,error,refresh}=useData<{enabled:boolean}>('/api/invoices/repair-policy',10000);
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[issues,setIssues]=useState(''),toast=useToast();
  async function save(enabled:boolean,acknowledgeDiscard=false) {
    const result=await post('/api/invoices/repair-policy',{enabled,acknowledgeDiscard});
    setIssues(result.result.issues.map((issue:{message:string})=>t(issue.message)).join('；'));
    toast(enabled?t('自动修复已开启，本次已修复 {0} 张账单',[result.result.repaired]):t('自动修复已关闭'));
    setConfirm(false);await refresh();await onChange();
  }
  return <section className="panel">
    <div className="panel-head"><div><h2>{t('重复快照自动修复')}</h2>
      <p>{t('开启后自动移除当前及今后待处理账单中的重复快照；正常明细保留，结算仍需确认。')}</p></div>
      <button className="button" disabled={!data||busy} onClick={async()=>{
        if(!data?.enabled){setConfirm(true);return;}
        setBusy(true);try{await save(false);}catch(error){toast((error as Error).message,'error');}finally{setBusy(false);}
      }}>{data?.enabled?t('关闭自动修复'):t('启用自动修复')}</button>
    </div>
    <ErrorBox error={error||issues}/>
    {confirm&&<Modal title={t('启用重复快照自动修复')} onClose={()=>setConfirm(false)}>
      <p>{t('仅处理与前一日相同的非零日快照。相同金额也可能是真实用量，启用即授权系统移除这些疑似重复项及其应收款。')}</p>
      <p>{t('开启后立即检查现有待处理账单，之后每分钟检查；已确认账单保持原样，所有修复保留记录。')}</p>
      <Form onSubmit={async form=>save(true,form.get('acknowledgeDiscard')==='on')}>
        <label className="checkbox-field"><input type="checkbox" name="acknowledgeDiscard" required/>{t('我同意按以上规则自动移除疑似重复明细及其应收款')}</label>
        <div className="modal-actions"><Submit>{t('确认开启自动修复')}</Submit></div>
      </Form>
    </Modal>}
  </section>;
}
