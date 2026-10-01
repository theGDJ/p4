import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button (shadcn/ui style, hand-authored — the shadcn registry is unreachable from
 * the build sandbox, so components are vendored rather than CLI-installed).
 *
 * Variants use only palette tokens from §11. Saffron never appears as a text or
 * background colour here; the contrast gate (`npm run contrast`) enforces that.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-navy text-paper-raised hover:bg-navy-hover active:bg-navy shadow-none',
        secondary: 'border border-line-strong bg-paper-raised text-ink hover:bg-paper-sunken',
        teal: 'bg-teal text-paper-raised hover:bg-teal-hover',
        ghost: 'text-ink hover:bg-paper-sunken',
        outline: 'border border-line-strong bg-transparent text-ink hover:bg-paper-sunken',
        danger: 'bg-error text-paper-raised hover:brightness-110',
        dangerOutline: 'border border-error text-error hover:bg-error-soft',
        link: 'text-teal underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4 text-sm',
        lg: 'h-11 px-5 text-[15px]',
        icon: 'h-9 w-9',
        iconSm: 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element (e.g. a React Router <Link>) while keeping styles. */
  asChild?: boolean;
  busy?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, busy = false, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? busy}
      aria-busy={busy || undefined}
      data-slot="button"
      {...props}
    >
      {busy ? (
        <>
          <Spinner aria-hidden="true" />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

/** Small, unobtrusive spinner. Inherits currentColor so it works on any variant. */
export function Spinner({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn('size-4 animate-spin', className)} {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export { Button, buttonVariants };
