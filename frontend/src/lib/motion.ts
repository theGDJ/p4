import type { Transition, Variants } from 'motion/react';

/**
 * Motion system — master spec §11.
 *
 * Everything here is 150–250 ms with an ease-out curve. Motion communicates state
 * changes (a panel opening, a message arriving); it is never decorative, and every
 * animation is disabled when the user prefers reduced motion.
 *
 * `useReducedMotion()` from motion/react is honoured per-component; the CSS layer
 * in index.css also collapses transitions globally as a backstop, so an animation
 * that bypasses these helpers still cannot run.
 */

export const DURATION = {
  fast: 0.15,
  base: 0.2,
  slow: 0.25,
} as const;

/** ease-out: fast start, gentle settle. */
export const EASE = [0.2, 0, 0, 1] as const;

export const transitionFast: Transition = { duration: DURATION.fast, ease: EASE };
export const transitionBase: Transition = { duration: DURATION.base, ease: EASE };
export const transitionSlow: Transition = { duration: DURATION.slow, ease: EASE };

/** Route fade (§11 "route fade"). */
export const routeFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

/** Message enter: a small rise, not a bounce. */
export const messageEnter: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0 },
};

/** Sidebar / evidence-rail slide. */
export const panelSlide = (direction: 'left' | 'right' = 'right'): Variants => ({
  initial: { opacity: 0, x: direction === 'right' ? 16 : -16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: direction === 'right' ? 16 : -16 },
});

/** Dropdown / modal. */
export const popoverScale: Variants = {
  initial: { opacity: 0, scale: 0.98, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: -4 },
};

/** Mobile bottom sheet (evidence rail on small screens). */
export const sheetUp: Variants = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%' },
};

/** Citation expand (§11 "citation expand"). */
export const expandCollapse: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
};

/** Tab switch. */
export const tabFade: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

/** Skeleton shimmer is deliberately subtle and slow; it must not flicker. */
export const skeletonPulse: Transition = {
  duration: 1.6,
  repeat: Number.POSITIVE_INFINITY,
  ease: 'easeInOut',
};

/** Stagger for lists (conversation history, citation rail). */
export function staggerContainer(step = 0.04): Variants {
  return {
    animate: { transition: { staggerChildren: step } },
  };
}

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: transitionBase },
};
