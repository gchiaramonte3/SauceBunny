/** Stacked audio lanes distinguish the workspace from the media Library. */
export function IconMultitrack({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 5h2m3 0h13M3 12h2m3 0h13M3 19h2m3 0h13" />
    <path d="M11 3v4m5 3v4m-5 3v4" />
  </svg>;
}
