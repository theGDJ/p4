import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'motion/react';
import { apiFetch } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Well } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { InformationalLabel } from '@/components/mock-badge';
import { messageEnter, staggerContainer, staggerItem, transitionBase } from '@/lib/motion';
import { cn, truncateWords } from '@/lib/utils';
import type { BootstrapResponse } from '@/lib/types';

/**
 * Landing page (P1 scope): headline, assistant input, example questions,
 * capabilities, and trust/source messaging.
 *
 * The assistant input is not decorative. Submitting it either continues into the
 * chat (signed in) or carries the draft to the sign-in screen and back, so the
 * control always does something real (§11: no dead buttons).
 */

export function LandingPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { status } = useSession();
  const reduceMotion = useReducedMotion();
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const bootstrapQuery = useQuery({
    queryKey: ['meta', 'bootstrap'],
    queryFn: () => apiFetch<BootstrapResponse>('/meta/bootstrap'),
    staleTime: 5 * 60 * 1000,
  });

  const authenticated = status === 'authenticated';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question) {
      inputRef.current?.focus();
      return;
    }
    const encoded = encodeURIComponent(truncateWords(question, 400));
    navigate(authenticated ? `/chat?q=${encoded}` : `/login?next=${encodeURIComponent(`/chat?q=${encoded}`)}`);
  };

  const askExample = (question: string) => {
    setDraft(question);
    inputRef.current?.focus();
  };

  const capabilities = t('landing.capabilities', { returnObjects: true }) as Array<{ title: string; body: string }>;
  const examples = t('landing.examples', { returnObjects: true }) as string[];
  const trustPoints = t('landing.trustPoints', { returnObjects: true }) as string[];
  const honestyPoints = t('landing.honestyPoints', { returnObjects: true }) as string[];

  const knowledge = bootstrapQuery.data?.knowledge;
  const knowledgeEmpty = knowledge ? knowledge.approvedChunks === 0 : undefined;

  return (
    <div className="mx-auto w-full max-w-[72rem] px-4 py-10 sm:py-14">
      {/* ---------------------------------------------------------- headline */}
      <motion.section
        initial={reduceMotion ? false : 'initial'}
        animate={reduceMotion ? undefined : 'animate'}
        variants={reduceMotion ? undefined : messageEnter}
        transition={reduceMotion ? { duration: 0 } : transitionBase}
        className="max-w-3xl"
      >
        <Badge variant="info" className="mb-4">
          {t('common.appName')} · {t('common.tagline')}
        </Badge>
        <h1 className="font-serif text-[2rem] leading-[1.15] font-semibold text-balance text-ink sm:text-[2.6rem]">
          {t('landing.headline')}
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-6 text-ink-muted">{t('landing.subheadline')}</p>
      </motion.section>

      {/* --------------------------------------------------- assistant input */}
      <section aria-labelledby="ask-heading" className="mt-8">
        <h2 id="ask-heading" className="sr-only">
          {t('landing.assistantHeading')}
        </h2>
        <form onSubmit={submit} className="paper-card p-3 sm:p-4">
          <label htmlFor="landing-question" className="mb-1.5 block text-[13px] font-semibold text-ink">
            {t('landing.assistantLabel')}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="landing-question"
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('landing.assistantPlaceholder')}
              autoComplete="off"
              maxLength={4000}
              aria-describedby="landing-question-hint"
              className="h-11 flex-1 rounded-md border border-line-strong bg-paper-raised px-3 text-[15px] text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
            />
            <Button type="submit" size="lg" className="h-11 shrink-0 sm:w-auto">
              {authenticated ? t('landing.askButton') : t('landing.signInToAsk')}
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
          </div>
          <p id="landing-question-hint" className="mt-2 text-[12.5px] leading-4 text-ink-muted">
            {t('chat.emptyBody')}
          </p>
        </form>

        {/* Example questions: real buttons that fill the field — never inert chips. */}
        <div className="mt-4">
          <p className="mb-2 text-[12.5px] font-semibold text-ink-muted">{t('landing.exampleQuestionsTitle')}</p>
          <ul className="flex flex-wrap gap-2">
            {examples.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => askExample(example)}
                  lang={/[\u0900-\u097F]/.test(example) ? 'hi' : 'en'}
                  className={cn(
                    'rounded-sm border border-line-strong bg-paper-raised px-3 py-1.5 text-left text-[13px] text-ink',
                    'transition-colors duration-150 ease-out hover:border-teal hover:bg-teal-soft',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal',
                  )}
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------- knowledge status */}
      <section aria-labelledby="kb-heading" className="mt-8">
        <h2 id="kb-heading" className="font-serif text-lg font-semibold text-ink">
          {t('landing.knowledgeStatus')}
        </h2>
        {bootstrapQuery.isLoading ? (
          <div className="mt-3 flex gap-3">
            <Skeleton className="h-16 flex-1" />
            <Skeleton className="h-16 flex-1" />
          </div>
        ) : bootstrapQuery.isError ? (
          <ErrorState
            className="mt-3"
            title={t('states.errorTitle')}
            body={t('states.errorBody')}
            retryLabel={t('common.retry')}
            onRetry={() => void bootstrapQuery.refetch()}
          />
        ) : (
          <>
            {/* A <dl> may only directly contain dt/dd groups or <div> wrappers —
                nesting them inside a Card makes the list invalid (axe: dlitem). */}
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <Well>
                <dt className="text-[12px] font-semibold text-ink-muted">{t('landing.approvedDocuments')}</dt>
                <dd className="std-no mt-1 text-2xl font-semibold text-ink">{knowledge?.approvedDocuments ?? 0}</dd>
              </Well>
              <Well>
                <dt className="text-[12px] font-semibold text-ink-muted">{t('landing.approvedChunks')}</dt>
                <dd className="std-no mt-1 text-2xl font-semibold text-ink">{knowledge?.approvedChunks ?? 0}</dd>
              </Well>
            </dl>
            {knowledgeEmpty ? (
              <p className="mt-3 rounded-md border border-warn bg-warn-soft px-3 py-2.5 text-[13px] leading-5 text-warn">
                {t('landing.emptyKnowledgeNote')}
              </p>
            ) : null}
            <p className="mt-2 text-[12px] text-ink-muted">
              {/* R10: these figures come from the server's real ingestion state. There is
                  no projected or illustrative number anywhere on this page. */}
              {i18n.language === 'hi' ? 'आँकड़े सर्वर की वास्तविक स्थिति से लिए गए हैं।' : 'Figures are read from the server’s real ingestion state.'}
            </p>
          </>
        )}
      </section>

      {/* ------------------------------------------------------ capabilities */}
      <section aria-labelledby="cap-heading" className="mt-12">
        <h2 id="cap-heading" className="font-serif text-xl font-semibold text-ink">
          {t('landing.capabilitiesTitle')}
        </h2>
        <motion.ul
          role="list"
          initial={reduceMotion ? false : 'initial'}
          whileInView={reduceMotion ? undefined : 'animate'}
          viewport={{ once: true, margin: '-40px' }}
          variants={reduceMotion ? undefined : staggerContainer()}
          className="mt-4 grid gap-3 sm:grid-cols-2"
        >
          {capabilities.map((capability) => (
            <motion.li
              key={capability.title}
              variants={reduceMotion ? undefined : staggerItem}
              transition={reduceMotion ? { duration: 0 } : transitionBase}
            >
              <Card className="h-full">
                <CardHeader>
                  <CardTitle>{capability.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-[13.5px] leading-6 text-ink-muted">{capability.body}</CardContent>
              </Card>
            </motion.li>
          ))}
        </motion.ul>
      </section>

      {/* ------------------------------------------------ trust and honesty */}
      <section className="mt-12 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('landing.trustTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {trustPoints.map((point) => (
                <li key={point} className="flex gap-2.5 text-[13.5px] leading-5 text-ink">
                  <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-verified" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M3 8.5 6.2 11.5 13 4.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="border-saffron">
          <CardHeader>
            <CardTitle>{t('landing.honestyTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {honestyPoints.map((point) => (
                <li key={point} className="flex gap-2.5 text-[13.5px] leading-5 text-ink">
                  <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-saffron" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M8 3.2v5.4M8 11.4v.9" strokeLinecap="round" />
                    <path d="M8 1.9 15 14H1L8 1.9Z" strokeLinejoin="round" />
                  </svg>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-line pt-3">
              <InformationalLabel />
            </div>
          </CardContent>
        </Card>
      </section>

      {/* --------------------------------------------------------------- CTA */}
      <section className="mt-12 rounded-md border border-line bg-paper-raised px-4 py-6 text-center">
        <h2 className="font-serif text-xl font-semibold text-ink">
          {authenticated ? t('nav.chat') : t('auth.registerTitle')}
        </h2>
        <p className="mx-auto mt-1.5 max-w-xl text-[13.5px] leading-5 text-ink-muted">
          {authenticated ? t('chat.emptyBody') : t('auth.registerSubtitle')}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {authenticated ? (
            <Button asChild size="lg">
              <Link to="/chat">{t('nav.chat')}</Link>
            </Button>
          ) : (
            <>
              <Button asChild size="lg">
                <Link to="/register">{t('nav.register')}</Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link to="/login">{t('nav.signIn')}</Link>
              </Button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
