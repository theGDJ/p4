import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Language } from '@/lib/types';

/**
 * Language switch (EN / हिन्दी).
 *
 * Implemented as a radiogroup of real buttons rather than a <select>, because it is
 * always visible in the header and a two-item toggle should not need two
 * interactions. The choice is persisted and also applied to `<html lang>` so the
 * Devanagari font face is selected by CSS (§11).
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { i18n, t } = useTranslation();
  const current: Language = i18n.language === 'hi' ? 'hi' : 'en';
  const [pending, setPending] = React.useState(false);

  const select = async (language: Language) => {
    if (language === current) return;
    setPending(true);
    try {
      await changeLanguage(language);
    } finally {
      setPending(false);
    }
  };

  const options: Array<{ value: Language; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'hi', label: 'हिन्दी' },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={t('common.language')}
      className={cn(
        'inline-flex items-center rounded-md border border-line bg-paper-raised p-0.5',
        pending && 'opacity-70',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={pending}
            onClick={() => void select(option.value)}
            lang={option.value}
            className={cn(
              'rounded-sm px-2.5 py-1 text-[12.5px] font-semibold transition-colors duration-150 ease-out',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal',
              selected ? 'bg-navy text-paper-raised' : 'text-ink-muted hover:bg-paper-sunken hover:text-ink',
              // No font class needed: the `lang` attribute above lets the
              // `:lang(hi)` rule in index.css select the Devanagari face (§11).
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
