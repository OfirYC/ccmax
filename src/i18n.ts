import en from './locales/en.json';
import vi from './locales/vi.json';
import hi from './locales/hi.json';

export const languages = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'hi', name: 'हिन्दी' },
] as const;
export type Locale = typeof languages[number]['code'];
export const defaultLocale: Locale = 'en';
export const localeStorageKey = 'ccmax.locale';
const dictionaries: Record<Exclude<Locale, 'zh-CN'>, Record<string, string>> = { en, vi, hi };
const listeners = new Set<() => void>();
const isLocale = (value: unknown): value is Locale => languages.some(language => language.code === value);

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(localeStorageKey);
    if (isLocale(saved)) return saved;
  } catch { /* Language switching also works when browser storage is unavailable. */ }
  return defaultLocale;
}

let locale = readLocale();
export const getLocale = () => locale;
export function t(source: string, values: readonly (string | number)[] = [], language = locale): string {
  const message = language === 'zh-CN' ? source : dictionaries[language][source] ?? source;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => String(values[Number(index)] ?? placeholder));
}

function updateDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.title = t('CCMAX · 账号与代理工作空间');
}

export function setLocale(next: Locale) {
  if (!isLocale(next)) return;
  try { localStorage.setItem(localeStorageKey, next); } catch { /* Keep the in-memory preference. */ }
  if (locale === next) return;
  locale = next;
  updateDocument();
  listeners.forEach(listener => listener());
}

export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') {
  updateDocument();
  window.addEventListener('storage', event => {
    if (event.key !== localeStorageKey && event.key !== null) return;
    locale = readLocale();
    updateDocument();
    listeners.forEach(listener => listener());
  });
}

const messageSources = new Map<string, string>();
const messagePatterns: { source: string; pattern: RegExp; indexes: number[]; specificity: number }[] = [];
for (const source of Object.keys(en)) {
  for (const message of new Set([source, en[source as keyof typeof en], vi[source as keyof typeof vi], hi[source as keyof typeof hi]])) {
    messageSources.set(message, source);
    if (!/\{\d+\}/.test(message)) continue;
    const indexes: number[] = [];
    const pattern = message.split(/(\{\d+\})/g).map(part => {
      const parameter = /^\{(\d+)\}$/.exec(part);
      if (parameter) { indexes.push(Number(parameter[1])); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    messagePatterns.push({ source, pattern: new RegExp(`^${pattern}$`), indexes, specificity: message.replace(/\{\d+\}/g, '').length });
  }
}
// Specific messages must win over generic suffixes such as "{0} effective at midnight".
// Otherwise switching an existing bulk-update toast translates only the suffix.
messagePatterns.sort((a,b)=>b.specificity-a.specificity||a.indexes.length-b.indexes.length);

// Translate known system messages only; account names and other user data stay intact.
// Match previous translations too, so visible errors and toasts update when switching.
export function translateMessage(message: string): string {
  const source = messageSources.get(message);
  if (source) return t(source);
  if (['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'].includes(message)) {
    return t('网络连接失败，请检查网络后重试');
  }
  for (const { source, pattern, indexes } of messagePatterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const values: string[] = [];
    indexes.forEach((index, position) => { values[index] = match[position + 1]; });
    return t(source, values);
  }
  // Validation responses may contain several messages prefixed by field names.
  if (message.includes('；')) return message.split('；').map(translateMessage).join('; ');
  const field = /^([\w.[\]-]+): (.+)$/.exec(message);
  if (field) return `${field[1]}: ${translateMessage(field[2])}`;
  return message;
}
