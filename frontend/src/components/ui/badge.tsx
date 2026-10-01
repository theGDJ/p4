import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import type { EvidenceTier, VerificationStatus } from '@/lib/types';

/**
 * Badge / status pill.
 *
 * Every variant pairs a text colour that clears 4.5:1 on its own tint (verified by
 * `npm run contrast`). Status is never conveyed by colour alone: each variant ships
 * with a label, and the verification badges carry an icon plus text (WCAG 1.4.1).
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11.5px] font-semibold leading-5 whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-line-strong bg-paper-sunken text-ink-muted',
        info: 'border-teal bg-teal-soft text-ink',
        verified: 'border-verified bg-verified-soft text-verified',
        warn: 'border-warn bg-warn-soft text-warn',
        error: 'border-error bg-error-soft text-error',
        outline: 'border-line-strong bg-transparent text-ink-muted',
        navy: 'border-navy bg-navy text-paper-raised',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/* ------------------------------------------------- verification status (R7) */

/**
 * R7: "verified" may be shown ONLY for VERIFIED status. Everything else gets its
 * own honest label. This map is the single place that decides the wording, so the
 * rule cannot be contradicted by an individual component.
 */
export const VERIFICATION_LABEL_EN: Record<VerificationStatus, string> = {
  VERIFIED: 'Verified',
  UNVERIFIED: 'Not yet verified',
  RESTRICTED: 'Restricted — metadata only',
  OUTDATED: 'Outdated',
  SUPERSEDED: 'Superseded',
};

export const VERIFICATION_LABEL_HI: Record<VerificationStatus, string> = {
  VERIFIED: 'सत्यापित',
  UNVERIFIED: 'अभी सत्यापित नहीं',
  RESTRICTED: 'प्रतिबंधित — केवल विवरण',
  OUTDATED: 'पुराना',
  SUPERSEDED: 'अधिक्रमित',
};

const VERIFICATION_VARIANT: Record<VerificationStatus, 'verified' | 'neutral' | 'warn' | 'error'> = {
  VERIFIED: 'verified',
  UNVERIFIED: 'neutral',
  RESTRICTED: 'warn',
  OUTDATED: 'warn',
  SUPERSEDED: 'error',
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M3 8.5 6.2 11.5 13 4.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M8 3v6M8 11.6v.9" strokeLinecap="round" />
      <circle cx="8" cy="8" r="6.4" strokeOpacity="0.55" />
    </svg>
  );
}

export function VerificationBadge({
  status,
  language,
  className,
}: {
  status: VerificationStatus;
  language: 'en' | 'hi';
  className?: string;
}) {
  const label = (language === 'hi' ? VERIFICATION_LABEL_HI : VERIFICATION_LABEL_EN)[status];
  const variant = VERIFICATION_VARIANT[status];
  return (
    <Badge variant={variant} className={className}>
      {status === 'VERIFIED' ? <CheckIcon /> : status === 'UNVERIFIED' ? null : <WarnIcon />}
      {label}
    </Badge>
  );
}

/* ------------------------------------------------------ evidence tier (§5.6) */

export const TIER_VARIANT: Record<EvidenceTier, 'verified' | 'warn' | 'neutral'> = {
  STRONG: 'verified',
  PARTIAL: 'warn',
  NONE: 'neutral',
};

export function TierBadge({
  tier,
  label,
  className,
}: {
  tier: EvidenceTier;
  label: string;
  className?: string;
}) {
  return (
    <Badge variant={TIER_VARIANT[tier]} className={className}>
      {label}
    </Badge>
  );
}

export { badgeVariants };
