import { useSyncExternalStore } from 'react';
import { Languages } from 'lucide-react';
import { defaultLocale, getLocale, languages, setLocale, subscribeLocale, t, type Locale } from './i18n';

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, () => defaultLocale);
}

export default function LanguageSwitcher() {
  const locale = useLocale();
  return <label className="language-switcher">
    <Languages size={16} aria-hidden="true" />
    <span className="sr-only">{t('语言')}</span>
    <select aria-label={t('语言')} value={locale} onChange={event => setLocale(event.target.value as Locale)}>
      {languages.map(language => <option key={language.code} value={language.code} lang={language.code}>{language.name}</option>)}
    </select>
  </label>;
}
