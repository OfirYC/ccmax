import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import en from './locales/en.json';
import vietnamese from './locales/vi.json';
import hi from './locales/hi.json';
import { getLocale, localeStorageKey, setLocale, subscribeLocale, t, translateMessage } from './i18n';
import { dateTime, localToday, money, number } from './api';

afterEach(() => { setLocale('en'); vi.unstubAllGlobals(); });

describe('language catalogs', () => {
  it('covers the same messages in all languages and preserves interpolation parameters', () => {
    const keys = Object.keys(en).sort();
    const parameters = (message: string) => [...message.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const catalog of [en, vietnamese, hi]) {
      expect(Object.keys(catalog).sort()).toEqual(keys);
      for (const [source, translated] of Object.entries(catalog)) {
        expect(translated.trim(), source).not.toBe('');
        expect(translated, source).not.toMatch(/[\u3400-\u9fff]/u);
        expect(parameters(translated), source).toEqual(parameters(source));
      }
    }
  });

  it('has translations for every static translation call in the interface', () => {
    const files = fs.readdirSync('src', { recursive: true }).map(String).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'));
    for (const file of files) {
      const source = ts.createSourceFile(file, fs.readFileSync(path.join('src', file), 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && ts.isStringLiteral(node.arguments[0])) {
          expect(en, `${file}: ${node.arguments[0].text}`).toHaveProperty(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  });
});

describe('language switching', () => {
  it('uses English as the default and interpolates user data literally', () => {
    expect(getLocale()).toBe('en');
    expect(t('你好，{0}', ['$& {1}'])).toBe('Hello, $& {1}');
    expect(t('unknown upstream message')).toBe('unknown upstream message');
  });

  it('persists the choice and notifies subscribers only on a change', () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const listener = vi.fn(), unsubscribe = subscribeLocale(listener);
    setLocale('vi');
    expect(storage.setItem).toHaveBeenCalledWith(localeStorageKey, 'vi');
    expect(t('语言')).toBe('Ngôn ngữ');
    setLocale('vi');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setLocale('hi');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('still switches when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { setItem() { throw new Error('blocked'); } });
    expect(() => setLocale('en')).not.toThrow();
    expect(t('账号管理')).toBe('Accounts');
  });

  it('translates backend errors and already visible messages without changing upstream details', () => {
    setLocale('en');
    const message = translateMessage('邮箱或密码错误，或账号已停用');
    expect(message).toBe(en['邮箱或密码错误，或账号已停用']);
    setLocale('hi');
    expect(translateMessage(message)).toBe(hi['邮箱或密码错误，或账号已停用']);
    expect(translateMessage('newPassword: 密码至少 12 位')).toBe(`newPassword: ${hi['密码至少 12 位']}`);
    expect(translateMessage('Upstream: example-user@example.com / 503')).toBe('Upstream: example-user@example.com / 503');
  });

  it('preserves dynamic error details when translating and switching languages', () => {
    setLocale('en');
    const message = translateMessage('User $& 在 2026-10-17 没有 Mini CC 结算折扣，无法记账');
    expect(message).toBe('User $& has no Mini CC settlement rate on 2026-10-17; posting is blocked');
    setLocale('vi');
    expect(translateMessage(message)).toBe('User $& chưa có tỷ lệ quyết toán Mini CC vào 2026-10-17; không thể ghi sổ');
  });

  it('translates Gatelink failure steps and safe validation metadata',()=>{
    const source='Gatelink 生成授权链接失败（HTTP 422）；参数校验未通过：proxy；Gatelink 的上游返回 HTTP 400';
    for(const locale of ['en','vi','hi'] as const) {
      setLocale(locale);
      const message=translateMessage(source);
      expect(message).not.toMatch(/[\u3400-\u9fff]/u);
      expect(message).toContain('proxy');
      expect(message).toContain('422');
      expect(message).toContain('400');
    }
  });

  it('translates Mini CC failure steps, read errors and uncertain write results',()=>{
    for(const locale of ['en','vi','hi'] as const) {
      setLocale(locale);
      const write=translateMessage('提交 OAuth 上号；平台请求超时（120 秒）；写入结果可能未知，请先核对上游结果');
      expect(write).not.toMatch(/[\u3400-\u9fff]/u);
      expect(write).toContain('120');
      expect(write).toContain(t('提交 OAuth 上号'));
      const read=translateMessage('读取账号详情；平台连接中断或网络异常');
      expect(read).toBe(`${t('读取账号详情')}; ${t('平台连接中断或网络异常')}`);
    }
  });

  it('translates the complete bulk-update toast before matching a generic effective-date suffix',()=>{
    const source='已调整 {0} 位直属下级，{1} 00:00 北京时间生效',values=[12,'2026-10-19'];
    const original=t(source,values);
    for(const locale of ['en','vi','hi'] as const){
      setLocale(locale);
      expect(translateMessage(original)).toBe(t(source,values));
      expect(translateMessage(original)).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it('formats USD, numbers, and Beijing times for the selected language', () => {
    expect(money(200)).toBe('$200.00');
    const billingDay = localToday();
    for (const locale of ['en', 'vi', 'hi'] as const) {
      setLocale(locale);
      expect(money(1234.5)).toBe(new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5));
      expect(number(1234567)).toBe((1234567).toLocaleString(locale));
      expect(dateTime('2026-10-17T16:30:00Z')).toBe(new Date('2026-10-17T16:30:00Z').toLocaleString(locale, { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
      expect(localToday()).toBe(billingDay);
    }
  });

  it('formats large decimal USD strings without losing digits through a Number conversion', () => {
    expect(money('9007199254740993.12345678', 8)).toBe('$9,007,199,254,740,993.12345678');
    expect(money('9999999999999999.99999999', 8)).toBe('$9,999,999,999,999,999.99999999');
    expect(money('1.005')).toBe('$1.01');
    expect(money('-1.005')).toBe('-$1.01');
    setLocale('vi');
    expect(money('9007199254740993.12345678', 8)).toContain('9.007.199.254.740.993,12345678');
    setLocale('hi');
    expect(money('9007199254740993.12345678', 8)).toContain('9,00,71,99,25,47,40,993.12345678');
  });
});
