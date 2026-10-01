import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { LoadingBlock } from './skeleton';

/**
 * The three states every list and page must have (§11): skeleton, empty, and
 * error-with-retry. They are components rather than ad-hoc JSX so that a page
 * cannot ship without one, and so the wording stays consistent EN/HI.
 */

export function ErrorState({
  title,
  body,
  onRetry,
  retryLabel,
  detail,
  className,
}: {
  title: string;
  body?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Optional non-sensitive detail, e.g. a traceRef, so support can find the log. */
  detail?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-2 rounded-md border border-error bg-error-soft px-4 py-3',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-error" fill="currentColor" aria-hidden="true">
          <path d="M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6ZM7.3 4.8h1.4v4.1H7.3V4.8Zm0 5.3h1.4v1.4H7.3v-1.4Z" />
        </svg>
        <div className="min-w-0">
          <p className="font-serif text-[15px] font-semibold text-ink">{title}</p>
          {body ? <p className="mt-0.5 text-[13px] leading-5 text-ink">{body}</p> : null}
          {detail ? <p className="mt-1 font-mono text-[11px] text-ink-muted">{detail}</p> : null}
        </div>
      </div>
      {onRetry ? (
        <Button variant="dangerOutline" size="sm" onClick={onRetry}>
          {retryLabel ?? 'Try again'}
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  /**
   * Optional. If omitted the block shows text only — §11 forbids decorative-only
   * elements, so an icon here must mean something (it is aria-hidden regardless).
   */
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-2 rounded-md border border-dashed border-line-strong bg-paper px-4 py-5',
        className,
      )}
    >
      {icon ? <span className="text-teal [&_svg]:size-5">{icon}</span> : null}
      <p className="font-serif text-[15px] font-semibold text-ink">{title}</p>
      {body ? <p className="text-[13px] leading-5 text-ink-muted">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label, rows = 3, className }: { label: string; rows?: number; className?: string }) {
  return <LoadingBlock label={label} rows={rows} className={className} />;
}

/**
 * Generic three-state switch so a page cannot forget one of them.
 * `data` is `undefined` while loading and stays `undefined` on error.
 */
export function QueryState<T>({
  isLoading,
  error,
  data,
  onRetry,
  retryLabel,
  loadingLabel,
  errorTitle,
  errorBody,
  errorDetail,
  empty,
  emptyState,
  children,
}: {
  isLoading: boolean;
  error: { message: string; traceRef?: string } | null;
  data: T | undefined;
  onRetry?: () => void;
  retryLabel: string;
  loadingLabel: string;
  errorTitle: string;
  errorBody?: string;
  errorDetail?: string;
  /** True when data is present but represents "nothing to show". */
  empty?: boolean;
  emptyState?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  if (isLoading) return <LoadingState label={loadingLabel} />;
  if (error) {
    return (
      <ErrorState
        title={errorTitle}
        body={error.message || errorBody}
        detail={errorDetail ?? error.traceRef}
        onRetry={onRetry}
        retryLabel={retryLabel}
      />
    );
  }
  if (data === undefined || data === null) return null;
  if (empty && emptyState) return <>{emptyState}</>;
  return <>{children(data)}</>;
}
