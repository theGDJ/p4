import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as Dialog from '@radix-ui/react-dialog';
import { Badge, VerificationBadge, TierBadge } from '@/components/ui/badge';
import { cn, formatDateTime } from '@/lib/utils';
import { expandCollapse, transitionBase } from '@/lib/motion';
import type { EvidenceTier, SourceSnapshot } from '@/lib/types';
import { EmptyState } from '@/components/ui/states';

/**
 * Evidence rail — feature #3 and the visual centre of the product (§11).
 *
 * Desktop: a fixed right-hand column. Mobile: the same content in a bottom sheet.
 * Every entry is expandable and shows the title, standard number, section/clause,
 * document type, verification status with its date, the source link, and the
 * evidence snippet itself — so a reader can check the claim without leaving the
 * page, which is the entire point of the tool.
 *
 * All display fields come from the server's source snapshot, never from the model
 * (R3). Nothing here is invented: if `sourceUrl` is absent we say so rather than
 * linking somewhere plausible.
 */

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M6.5 3.5H3.2v9.3h9.3V9.5M9 3h4v4M13 3 7.4 8.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CitationCard({
  source,
  defaultOpen = false,
  className,
}: {
  source: SourceSnapshot;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(defaultOpen);
  const reduceMotion = useReducedMotion();
  const panelId = `citation-panel-${source.ref}`;

  return (
    <li className={cn('border-b border-line last:border-b-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-paper-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal"
      >
        {/* The [S#] reference is the same token the answer text uses. */}
        <span className="std-no mt-0.5 shrink-0 rounded-sm border border-line-strong bg-paper px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted">
          {source.ref}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{source.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {source.standardNo ? (
              <span className="std-no rounded-sm bg-navy-soft px-1.5 py-0.5 text-[11px] font-semibold text-ink">
                {source.standardNo}
              </span>
            ) : null}
            {source.section ? <span className="std-no text-[11px] text-ink-muted">{source.section}</span> : null}
            <VerificationBadge status={source.verificationStatus} language={i18n.language === 'hi' ? 'hi' : 'en'} />
          </span>
        </span>
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className={cn(
            'mt-1 size-3.5 shrink-0 text-ink-muted transition-transform ease-out',
            open ? 'rotate-180' : 'rotate-0',
          )}
          style={{ transitionDuration: reduceMotion ? '0ms' : '200ms' }}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M4 6.5 8 10.5 12 6.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            key="panel"
            variants={reduceMotion ? undefined : expandCollapse}
            initial={reduceMotion ? false : 'initial'}
            animate={reduceMotion ? undefined : 'animate'}
            exit={reduceMotion ? undefined : 'exit'}
            transition={reduceMotion ? { duration: 0 } : transitionBase}
            className="overflow-hidden"
          >
            <dl className="space-y-2 border-t border-dotted border-line-strong bg-paper px-3 py-3 text-[12.5px]">
              <Row label={t('citations.docType')}>
                <Badge variant="outline">{source.docType}</Badge>
              </Row>
              <Row label={t('citations.language')}>
                <span className="text-ink">{source.language === 'hi' ? t('common.hindi') : t('common.english')}</span>
              </Row>
              <Row label={t('citations.lastVerified')}>
                {source.verificationStatus === 'VERIFIED' && source.verifiedAt ? (
                  <span className="text-ink">{formatDateTime(source.verifiedAt, i18n.language)}</span>
                ) : (
                  <span className="text-ink-muted">{t('citations.notVerified')}</span>
                )}
              </Row>
              <Row label={t('citations.snippet')}>
                <p className="rounded-sm border border-line bg-paper-raised px-2 py-1.5 leading-5 text-ink">
                  {source.snippet}
                </p>
              </Row>
              <Row label={t('citations.viewSource')}>
                {source.sourceUrl ? (
                  <a
                    href={source.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1 font-medium text-teal underline-offset-4 hover:underline"
                  >
                    <ExternalLinkIcon />
                    <span className="truncate">{source.sourceUrl.replace(/^https?:\/\//, '')}</span>
                  </a>
                ) : (
                  <span className="text-ink-muted">{t('citations.noLink')}</span>
                )}
              </Row>
            </dl>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-2">
      <dt className="pt-0.5 text-[11.5px] font-semibold text-ink-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export const TIER_LABEL_KEY: Record<EvidenceTier, string> = {
  STRONG: 'chat.tierStrong',
  PARTIAL: 'chat.tierPartial',
  NONE: 'chat.tierNone',
};

export function EvidenceRail({
  sources,
  tier,
  className,
  title,
}: {
  sources: SourceSnapshot[];
  tier: EvidenceTier | null;
  className?: string;
  title?: string;
}) {
  const { t } = useTranslation();

  return (
    <aside
      aria-label={t('citations.railLabel')}
      className={cn('flex min-h-0 flex-col border-line bg-paper-raised', className)}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <h2 className="font-serif text-[15px] font-semibold text-ink">{title ?? t('citations.title')}</h2>
        {sources.length > 0 ? (
          <span className="std-no text-[11.5px] text-ink-muted">
            {sources.length === 1 ? t('citations.oneSource') : t('citations.count', { count: sources.length })}
          </span>
        ) : null}
      </header>

      {tier ? (
        <div className="border-b border-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] font-semibold text-ink-muted">{t('chat.tierLabel')}</span>
            <TierBadge tier={tier} label={tier} />
          </div>
          <p className="mt-1 text-[12px] leading-4 text-ink-muted">{t(TIER_LABEL_KEY[tier])}</p>
        </div>
      ) : null}

      {sources.length === 0 ? (
        <div className="p-3">
          <EmptyState title={t('citations.emptyTitle')} body={t('citations.emptyBody')} />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {sources.map((source, index) => (
            <CitationCard key={source.chunkId || source.ref} source={source} defaultOpen={index === 0} />
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * Mobile evidence rail: the same citations in a bottom sheet (§11).
 * Controlled by the parent so the "Sources" button in the message row can open it.
 */
export function EvidenceSheet({
  open,
  onOpenChange,
  sources,
  tier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: SourceSnapshot[];
  tier: EvidenceTier | null;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-200" />
        <Dialog.Content
          className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-hidden rounded-t-lg border-t border-line bg-paper-raised data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom duration-250 ease-out focus:outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <Dialog.Title className="font-serif text-base font-semibold text-ink">
              {t('citations.title')}
            </Dialog.Title>
            {tier ? <TierBadge tier={tier} label={tier} /> : null}
            <Dialog.Close
              className="rounded-sm p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
              aria-label={t('common.close')}
            >
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {sources.length === 0 ? (
              <div className="p-4">
                <EmptyState title={t('citations.emptyTitle')} body={t('citations.emptyBody')} />
              </div>
            ) : (
              <ul>
                {sources.map((source, index) => (
                  <CitationCard key={source.chunkId || source.ref} source={source} defaultOpen={index === 0} />
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
