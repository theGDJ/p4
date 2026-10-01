import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { hi } from './hi';
import type { Language } from '../lib/types';

/**
 * Bilingual i18n (§3, §11). English and Hindi only.
 *
 * `escapeValue` is off because React already escapes rendered text — leaving it on
 * would double-escape and mangle the Hindi copy. This does not weaken output
 * escaping (§8): nothing here is rendered as HTML, and the markdown renderer used
 * for answers sanitises separately.
 */

export const STORAGE_KEY = 'bis-saathi:language';
export const LANGUAGES: Language[] = ['en', 'hi'];

function detectInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'hi') return stored;
  } catch {
    // Private browsing can throw on localStorage; fall through to the browser hint.
  }
  const nav = typeof navigator === 'undefined' ? '' : navigator.language;
  return nav.toLowerCase().startsWith('hi') ? 'hi' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hi: { translation: hi },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'en',
  supportedLngs: LANGUAGES,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Applies the language to <html> so CSS `:lang(hi)` picks the Devanagari face (§11). */
export function applyLanguage(language: Language): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language;
  }
}

applyLanguage(i18n.language === 'hi' ? 'hi' : 'en');

export async function changeLanguage(language: Language): Promise<void> {
  await i18n.changeLanguage(language);
  applyLanguage(language);
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Persistence is best-effort; the in-memory choice still applies.
  }
}

export function currentLanguage(): Language {
  return i18n.language === 'hi' ? 'hi' : 'en';
}

export default i18n;
