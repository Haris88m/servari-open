/**
 * SERVARI OS — Shared animation constants.
 * Three classes: INSTANT / SNAPPY / COMPOSED + a SPRING variant.
 * Import these everywhere — never define duration/ease inline in components.
 */

/** INSTANT — hover state changes, toggle states (<100ms) */
export const INSTANT = { duration: 0.08, ease: "easeOut" } as const;

/** SNAPPY — panel/card transitions, navigation (150-200ms) */
export const SNAPPY = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

/** COMPOSED — page-level entrance, large layout shifts (320-420ms) */
export const COMPOSED = {
  duration: 0.38,
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

/** SPRING_SNAPPY — interactive elements with physical feedback */
export const SPRING_SNAPPY = {
  type: "spring",
  stiffness: 480,
  damping: 30,
  mass: 0.5,
} as const;

/** STAGGER — list item entrance: SNAPPY with per-item delay, max 8 items */
export function staggerItem(index: number) {
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { ...SNAPPY, delay: Math.min(index, 7) * 0.04 },
  };
}
