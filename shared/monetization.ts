import Decimal from 'decimal.js';

export type WeeklyRecord = { from: string; to: string; receivableUsd: string };
export type WeeklyRecordReport = { asOf: string; days: 7; record: WeeklyRecord | null };

export const monetizationReference = {
  plan: 'Claude Max 20x',
  checkedAt: '2026-10-19',
  usageSource: 'https://support.claude.com/en/articles/11049741-what-is-the-max-plan',
  apiCreditsSource: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
  pricingSource: 'https://claude.com/pricing',
} as const;

export function bestQuote(rates: Record<string, unknown>) {
  const quotes = Object.entries(rates).filter((entry): entry is [string, string | number] => {
    const value = entry[1];
    return (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) || typeof value === 'number' && Number.isFinite(value))
      && new Decimal(value as string | number).gte(0) && new Decimal(value as string | number).lte(1);
  });
  quotes.sort((a, b) => new Decimal(b[1]).comparedTo(a[1]) || a[0].localeCompare(b[0]));
  return quotes.length ? { provider: quotes[0][0], rate: String(quotes[0][1]) } : null;
}

export function calculateQuotedEarnings(input: { weeklyBillableUsd: string; monthlyBillableUsd: string; rate: string; subscriptionUsd: string; monthlyProxyUsd: string }) {
  const parse = (value: string, max: string) => {
    if (!/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/.test(value)) return null;
    const decimal = new Decimal(value);
    return decimal.lte(max) ? decimal : null;
  };
  const rate = parse(input.rate, '1');
  if (!rate) return null;
  const weekly = parse(input.weeklyBillableUsd, '9999999999999999'), monthly = parse(input.monthlyBillableUsd, '9999999999999999');
  const subscription = parse(input.subscriptionUsd, '9999999999999999'), proxy = parse(input.monthlyProxyUsd, '9999999999999999');
  const money = (value: Decimal | null) => value === null ? null : value.toFixed(2);
  return {
    week: money(weekly?.mul(rate) ?? null), month: money(monthly?.mul(rate) ?? null),
    monthAfterCosts: money(monthly && subscription && proxy ? monthly.mul(rate).minus(subscription).minus(proxy) : null),
  };
}
