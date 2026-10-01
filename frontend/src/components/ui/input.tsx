import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Text input.
 *
 * Border uses `--line-strong` (3.08:1 on paper) so the field boundary meets
 * WCAG 1.4.11; the invalid state uses `--error` (6.16:1). Focus is a 2px teal
 * ring with a 2px offset — never colour alone, since `aria-invalid` and the
 * message text carry the same information.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex h-10 w-full rounded-md border bg-paper-raised px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-faint',
        'transition-colors duration-150 ease-out',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal',
        'disabled:cursor-not-allowed disabled:bg-paper-sunken disabled:opacity-70',
        invalid ? 'border-error' : 'border-line-strong',
        className,
      )}
      {...props}
    />
  );
});

export { Input };
