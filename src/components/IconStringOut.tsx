/**
 * Bites laid end to end on one track: a string out. The nav rail puts it
 * right under AAF Audio, whose icon is stacked lanes with fader ticks, and the
 * old line-and-tick drawing read as the same thing twice.
 */
export function IconStringOut({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5.5" width="5" height="9" rx="1.2" />
    <rect x="10" y="5.5" width="6.5" height="9" rx="1.2" />
    <rect x="18.5" y="5.5" width="2.5" height="9" rx="1" />
    <path d="M3 18.5h18" />
  </svg>;
}
