/**
 * Generated pictures for the stage, so the prototype shows a real-looking
 * shared window and program feed without any media: an edit suite's window
 * (16:10, the shape of an application window) and a frame with burned-in
 * timecode (16:9).
 */
const CLIPS: [number, number, number, string][] = [
  [0, 20, 260, "#4f6bd8"], [0, 300, 420, "#4f6bd8"], [0, 740, 300, "#4f6bd8"], [0, 1060, 520, "#4f6bd8"],
  [1, 60, 380, "#3fa37a"], [1, 470, 520, "#3fa37a"], [1, 1010, 420, "#3fa37a"],
  [2, 20, 640, "#3fa37a"], [2, 700, 260, "#3fa37a"], [2, 980, 600, "#3fa37a"],
  [3, 140, 300, "#9b6bd8"], [3, 820, 360, "#9b6bd8"], [4, 20, 1560, "#7d8796"],
];

export function WindowScene() {
  return <svg viewBox="0 0 1600 1000" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="cp-rf-rec" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#25406b" /><stop offset="0.6" stopColor="#c27a52" /><stop offset="1" stopColor="#3a2c26" /></linearGradient>
    </defs>
    <rect width="1600" height="1000" fill="#1c1e23" />
    <rect width="1600" height="34" fill="#2b2e35" />
    {["#ff5f57", "#febc2e", "#28c840"].map((fill, index) => <circle key={fill} cx={22 + index * 22} cy="17" r="6" fill={fill} />)}
    <rect x="0" y="34" width="290" height="560" fill="#23262c" />
    {Array.from({ length: 12 }, (_, index) => <rect key={index} x="20" y={60 + index * 40} width={150 + (index % 3) * 40} height="12" rx="3" fill="#3a3e47" />)}
    <rect x="300" y="44" width="640" height="360" fill="#0b0c0e" />
    <rect x="320" y="64" width="600" height="320" fill="#2f3440" />
    <rect x="950" y="44" width="640" height="360" fill="#0b0c0e" />
    <rect x="970" y="64" width="600" height="320" fill="url(#cp-rf-rec)" />
    <circle cx="1370" cy="170" r="34" fill="#f2c37b" opacity="0.85" />
    <path d="M970 384 L1120 250 L1230 330 L1360 220 L1570 384 Z" fill="#1d2430" />
    <rect x="300" y="414" width="1290" height="170" fill="#202329" />
    {Array.from({ length: 5 }, (_, index) => <rect key={index} x="320" y={432 + index * 28} width={260 + index * 90} height="10" rx="3" fill="#353a44" />)}
    <rect x="0" y="600" width="1600" height="400" fill="#16181c" />
    {Array.from({ length: 5 }, (_, row) => <rect key={row} x="0" y={640 + row * 64} width="1600" height="56" fill={row % 2 ? "#1a1c21" : "#1d2026"} />)}
    {CLIPS.map(([row, x, width, fill]) => <rect key={`${row}-${x}`} x={x} y={646 + row * 64} width={width} height="44" rx="4" fill={fill} opacity="0.9" />)}
    <rect x="0" y="606" width="1600" height="26" fill="#22252b" />
    <rect x="812" y="606" width="3" height="394" fill="#e5484d" />
  </svg>;
}

/** A frame of program or of the shared file, with its timecode burned in as an edit suite sends it. */
export function FrameScene({ label, timecode }: { label: string; timecode: string | null }) {
  return <svg viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="cp-rf-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1b2b4c" /><stop offset="0.55" stopColor="#d07e57" /><stop offset="1" stopColor="#f0c08a" /></linearGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#cp-rf-sky)" />
    <circle cx="1320" cy="560" r="120" fill="#ffe2a8" opacity="0.9" />
    <path d="M0 760 L320 520 L560 700 L860 470 L1180 720 L1500 540 L1920 780 L1920 1080 L0 1080 Z" fill="#2b2433" />
    <path d="M0 880 L420 760 L900 900 L1400 790 L1920 900 L1920 1080 L0 1080 Z" fill="#191520" />
    <text x="60" y="96" fill="#ffffff" opacity="0.75" fontSize="40" fontFamily="sans-serif">{label}</text>
    {timecode && <><rect x="760" y="960" width="400" height="70" rx="8" fill="#000000" opacity="0.55" />
      <text x="960" y="1008" fill="#ffffff" fontSize="44" fontFamily="monospace" textAnchor="middle">{timecode}</text></>}
  </svg>;
}
