import { useTranslation } from 'react-i18next';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Badge } from '@/components/ui/badge';
import { useSession } from '@/lib/auth';

/**
 * "Mock provider" badge.
 *
 * R8 and R10 in UI form: when no real language model is configured, the interface
 * must say so permanently and visibly. A mock answer must never be able to pass
 * for a grounded one, and a reviewer must not mistake an empty answer for a
 * working system.
 *
 * The badge renders nothing at all when a real provider is configured, so it cannot
 * become background noise in production.
 */
export function MockProviderBadge({ className }: { className?: string }) {
  const { bootstrap } = useSession();
  const { t } = useTranslation();

  if (!bootstrap?.app.mockProvider) return null;

  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className={className}>
            <Badge variant="warn" className="cursor-help gap-1">
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                <path d="M8 2.6v6.1M8 11.4v1" strokeLinecap="round" />
                <path d="M8 1.8 15 14H1L8 1.8Z" strokeLinejoin="round" />
              </svg>
              {t('chat.mockBadge')}
            </Badge>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="start"
            sideOffset={8}
            className="z-50 max-w-sm rounded-md border border-line bg-paper-raised px-3 py-2 text-[12.5px] leading-5 text-ink shadow-[0_8px_24px_-12px_rgba(11,37,69,0.3)] data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 duration-150"
          >
            <Tooltip.Arrow className="fill-paper-raised" />
            <p className="font-semibold">{t('chat.mockBadgeTitle')}</p>
            <p className="mt-1 text-ink-muted">{t('chat.mockBadgeBody')}</p>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/**
 * R5 label. Rendered with recommendations, reports and guides — anywhere the
 * product could be mistaken for an authority.
 */
export function InformationalLabel({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={'flex items-start gap-1.5 text-[12px] leading-4 text-ink-muted ' + (className ?? '')}>
      <svg viewBox="0 0 16 16" className="mt-px size-3.5 shrink-0 text-saffron" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="8" cy="8" r="6.3" />
        <path d="M8 7.2v3.6M8 5.1v.9" strokeLinecap="round" />
      </svg>
      <span>{t('chat.informational')}</span>
    </p>
  );
}
