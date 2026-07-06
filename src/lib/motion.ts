/**
 * Scroll behavior that respects the OS "Reduce motion" setting: animated
 * scrolling normally, instant jumps when the user asked for less motion.
 * Used by the transcript karaoke autoscroll, search-jump, and the AI chat
 * scroll-to-bottom.
 */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
