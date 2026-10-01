import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Skeleton (§11: "Every list/page has skeleton, empty and error+retry states").
 *
 * The shimmer is a slow opacity pulse, not a moving gradient — it is disabled
 * entirely under `prefers-reduced-motion` by the global rule in index.css, and the
 * block still reads as a placeholder because it keeps its shape and tint.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-sm bg-paper-sunken', className)}
      style={{ animationDuration: '1.6s' }}
      {...props}
    />
  );
}

/** A labelled, screen-reader-announced loading region. */
export function LoadingBlock({ label, className, rows = 3 }: { label: string; className?: string; rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn('space-y-2', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === rows - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </div>
  );
}
