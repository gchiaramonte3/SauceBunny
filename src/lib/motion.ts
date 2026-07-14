/**
 * Scroll behavior that respects the OS "Reduce motion" setting: animated
 * scrolling normally, instant jumps when the user asked for less motion.
 * Used by the transcript karaoke autoscroll, search-jump, and the AI chat
 * scroll-to-bottom.
 */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function scrollBehavior(): ScrollBehavior {
  return reducedMotion.matches ? "auto" : "smooth";
}
