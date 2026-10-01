import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

/** Label. Always paired with a control via `htmlFor` — no floating labels. */
const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        'text-[13px] font-semibold leading-5 text-ink',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  );
});

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
}

/**
 * Field wrapper that keeps label, control, hint and error in a consistent order.
 *
 * Pass a render function as `children` and the ARIA wiring is supplied for you, so
 * `aria-describedby`/`aria-invalid` can never be forgotten on a form control:
 *
 *   <Field label="Email" htmlFor="email" error={err}>
 *     {(props) => <Input {...props} />}
 *   </Field>
 *
 * A plain node is also accepted when the caller wires the control itself.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode | ((props: FieldControlProps) => React.ReactNode);
  className?: string;
}) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const controlProps: FieldControlProps = {
    id: htmlFor,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
    ...(required ? { 'aria-required': true } : {}),
  };
  const rendered = typeof children === 'function' ? children(controlProps) : children;
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        {/* The required asterisk is a SIBLING of the <label>, not a child of it.
            Nesting it inside would change the label's text content — which is both
            its accessible name and what `getByLabelText` matches on. The state
            itself is carried by `aria-required` on the control. */}
        <span className="flex items-baseline gap-0.5">
          <Label htmlFor={htmlFor}>{label}</Label>
          {required ? (
            <span className="text-error" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        {hint && !error ? (
          <span id={hintId} className="text-xs text-ink-muted">
            {hint}
          </span>
        ) : null}
      </div>
      {rendered}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-[13px] font-medium text-error"
        >
          <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" fill="currentColor" aria-hidden="true">
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 5h1.5v4h-1.5V5Zm0 5.25h1.5v1.5h-1.5v-1.5Z" />
          </svg>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { Label };
