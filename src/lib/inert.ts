import type { HTMLAttributes } from "react";

/**
 * Props that make a collapsed panel genuinely unreachable.
 *
 * WHY `aria-hidden` ALONE IS A BUG, not merely incomplete. Both collapsed
 * panels in this app set `aria-hidden` and close by animating to `width: 0`
 * with `overflow: hidden` — not `display: none`. A zero-width element is still
 * laid out, and everything inside it is still focusable. So Tab walked a
 * keyboard user through roughly forty invisible controls, including "Export N
 * clips", while `aria-hidden` told the screen reader to say nothing about any
 * of them. That combination is worse than either problem alone: it is a
 * silent, unannounced path to a destructive button.
 *
 * `inert` is the attribute that actually means it — no focus, no clicks, no
 * accessibility tree, no find-in-page — and it has been in WebKit since Safari
 * 15.5, comfortably below this app's macOS 14 floor.
 *
 * THE TRAP THIS FUNCTION EXISTS TO AVOID: `inert` is presence-based, exactly
 * like `disabled`. `inert="false"` is still inert. React 18 renders unknown
 * attributes verbatim, so writing `inert={open ? "false" : "true"}` would
 * permanently freeze the panel in its OPEN state — a much worse bug than the
 * one being fixed, and one that would look correct in the JSX. The attribute
 * has to be absent, which is why this returns an object to spread rather than
 * a value to assign.
 */
export function inertWhen(inactive: boolean): HTMLAttributes<HTMLElement> {
  // `inert` is not in @types/react 18's HTMLAttributes (it landed with React
  // 19's types). The cast is confined to this one line rather than spread
  // across every call site.
  return (inactive ? { inert: "" } : {}) as HTMLAttributes<HTMLElement>;
}
