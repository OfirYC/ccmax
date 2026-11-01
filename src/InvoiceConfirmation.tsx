import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError, day, post, useData } from './api';
import { Amount } from './PriceDisplay';
import { ErrorBox, Field, Form, Loading, Modal, Submit, Table, useSession, useToast } from './components';
import { t } from './i18n';
import { useLocale } from './LanguageSwitcher';
import { platformName } from './platforms';
import type { previewInvoiceRepair } from '../server/invoice-repair';

type Preview = Awaited<ReturnType<typeof previewInvoiceRepair>>;
type Invoice = Record<string, any>;

function DuplicateRepair({ invoice, onBack, onRepaired }: {
  invoice: Invoice; onBack: () => void; onRepaired: (replacement: Invoice | null) => Promise<void>;
}) {
  const { data, error, loading, refresh } = useData<Preview>(`/api/invoices/${invoice.id}/repair-preview`);
  if (loading) return <Loading/>;
  if (!data || error) return <><ErrorBox error={error}/><button className="button" onClick={refresh}>{t('重新读取重复明细')}</button></>;
  return <>
    <p className="warning-text">{t('金额相同不一定代表重复。请先核对上游日账单，确认移除后，这些明细将不再计费。')}</p>
    <Table headers={[t('账号 / 平台'), t('账单日 / 相同快照日'), t('原始用量 USD'), t('移除应收 USD')]}>
      {data.items.map(item => <tr key={item.usage_id}>
        <td><strong>{item.email}</strong><small>{platformName(item.provider)}</small></td>
        <td>{day(item.day)}<small>{day(item.previous_day)}</small></td>
        <td className="amount-cell"><Amount value={item.raw_usd} digits={8}/></td>
        <td className="amount-cell"><Amount value={item.gross_usd} digits={8}/></td>
      </tr>)}
    </Table>
    <div className="confirm-amount">
      <div className="confirm-breakdown">
        <div><span>{t('原账单应收')}</span><Amount value={data.original.gross_usd} digits={8}/></div>
        <div><span>{t('本次移除应收')}</span><Amount value={data.removed.gross_usd} digits={8}/></div>
      </div>
      <div className="confirm-total"><span>{t('修复后应收 · USD')}</span><Amount value={data.remaining.gross_usd} digits={8} tone="settlement"/></div>
      <div className="confirm-breakdown">
        <div><span>{t('本人利润')}</span><Amount value={data.remaining.profit_usd} digits={8} tone="profit"/></div>
        <div><span>{t('下级应付')}</span><Amount value={data.remaining.downstream_usd} digits={8}/></div>
      </div>
      <p>{data.remaining.count ? t('原账单将作废，正常明细生成更正账单，仍需单独确认结算。') : t('本账单全部为重复明细，移除后原账单作废，无需结算。')}</p>
      <p>{t('本次仅修复当前账单，保留原始用量及处理记录。')}</p>
    </div>
    <Form key={data.previewToken} onSubmit={async form => {
      try {
        const result = await post(`/api/invoices/${invoice.id}/repair-duplicates`, {
          previewToken: data.previewToken, reason: form.get('reason'), acknowledgeDiscard: form.get('acknowledgeDiscard') === 'on',
        });
        await onRepaired(result.replacement);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) await refresh();
        throw error;
      }
    }}>
      <Field label={t('修复说明')}><textarea name="reason" required minLength={3} maxLength={500} rows={2}/></Field>
      <label className="checkbox-field"><input name="acknowledgeDiscard" type="checkbox" required/>{t('我已核对，确认移除以上明细及其应收款')}</label>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onBack}>{t('返回核对')}</button>
        <Submit>{t('确认移除重复明细')}</Submit>
      </div>
    </Form>
  </>;
}

export function InvoiceConfirmation({ invoice, onClose, onComplete, onReplacement }: {
  invoice: Invoice; onClose: () => void; onComplete: () => Promise<unknown>; onReplacement: (invoice: Invoice) => void;
}) {
  useLocale();
  const { user } = useSession(), toast = useToast();
  const [conflict, setConflict] = useState(false), [repair, setRepair] = useState(false);
  return <Modal title={repair ? t('修复账单：移除重复明细') : invoice.payer_id ? t('确认直属下级结算') : t('确认收到上游回款')}
    subtitle={invoice.number} onClose={onClose} wide={repair}>
    {repair ? <DuplicateRepair invoice={invoice} onBack={() => setRepair(false)} onRepaired={async replacement => {
      toast(replacement ? t('重复明细已移除，请核对更正账单后继续结算') : t('重复明细已移除，原账单已作废，无需结算'));
      await onComplete();
      if (replacement) onReplacement(replacement); else onClose();
    }}/> : <>
      <div className="confirm-amount">
        <div className="confirm-total"><span>{t('本次结算应收 · USD')}</span><Amount value={invoice.gross_usd} tone="settlement"/></div>
        <div className="confirm-breakdown">
          <div><span>{t('本人利润')}</span><Amount value={invoice.profit_usd} tone="profit"/></div>
          <div><span>{t('下级应付')}</span><Amount value={invoice.downstream_usd}/></div>
        </div>
        <p>{t('本人利润和团队应付均计入同一可提现余额，内部独立核对。')}</p>
      </div>
      {Number(invoice.profit_usd) < 0 && <div className="notice pricing-warning"><ShieldCheck size={18}/><span>{t('本账单为负利润，确认后将按真实亏损扣减该成员余额。请核对合同价和下级应付款。')}</span></div>}
      {invoice.estimated && <p className="warning-text">{t('快照预估')}</p>}
      <Form onSubmit={async form => {
        try { await post(`/api/invoices/${invoice.id}/confirm`, { reference: form.get('reference') }); }
        catch (error) {
          if (error instanceof ApiError && error.code === 'REPEATED_SNAPSHOT_CONFLICT') setConflict(true);
          throw error;
        }
        toast(t('账单已确认，利润流水已入账')); onClose(); await onComplete();
      }}>
        <Field label={t('回款凭证 / 结算确认说明')}><textarea name="reference" required minLength={3} maxLength={500} rows={3}
          placeholder={t('填写已收到的上游回款凭证或逐级结算确认记录')}/></Field>
        <div className="modal-actions"><Submit>{t('确认并记入利润账本')}</Submit></div>
      </Form>
      {conflict && (user.role === 'owner'
        ? <div className="inline-retry"><button className="button" onClick={() => setRepair(true)}>{t('修复账单：移除重复明细')}</button></div>
        : <p className="warning-text">{t('请联系管理员核对并修复重复明细。')}</p>)}
    </>}
  </Modal>;
}
