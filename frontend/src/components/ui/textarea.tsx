import * as React from 'react';
import { cn } from '@/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex w-full rounded-md border bg-paper-raised px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-faint',
        'transition-colors duration-150 ease-out',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal',
        'disabled:cursor-not-allowed disabled:bg-paper-sunken disabled:opacity-70',
        'resize-y',
        invalid ? 'border-error' : 'border-line-strong',
        className,
      )}
      {...props}
    />
  );
});

/**
 * Native select, deliberately.
 *
 * A custom listbox costs a lot of keyboard and screen-reader work to get right;
 * the platform control already handles arrow keys, type-ahead, mobile pickers and
 * localisation. Styled to match the input so the form reads as one system.
 */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  placeholder?: string;
};

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, placeholder, children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-10 w-full appearance-none rounded-md border bg-paper-raised pl-3 pr-9 text-sm text-ink',
          'transition-colors duration-150 ease-out',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal',
          'disabled:cursor-not-allowed disabled:bg-paper-sunken disabled:opacity-70',
          invalid ? 'border-error' : 'border-line-strong',
          className,
        )}
        {...props}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {children}
      </select>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-ink-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M4 6.5 8 10.5 12 6.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical'; decorative?: boolean }) {
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={!decorative && orientation === 'vertical' ? 'vertical' : undefined}
      className={cn(
        'shrink-0 bg-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea, Select };
