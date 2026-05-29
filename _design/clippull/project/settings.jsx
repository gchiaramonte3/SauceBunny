// settings.jsx — Settings modal with tabs.
// Tabs: General, Sources, Export defaults, Shortcuts (with keyboard UI),
// Pipeline, About.

// ============================================================
// SHORTCUTS — single source of truth for the keyboard view
// ============================================================
// Each shortcut has:
//   - keys:    array of one or more key glyphs (the visible "kbd" labels)
//   - codes:   array of kb-key ids to highlight on the visual keyboard
//              (multi-codes mean "press together")
//   - cat:     transport | marking | navigation | source | export | window
//   - label:   plain English description
const SHORTCUTS = [
  // Transport
  { keys: ['Space'],         codes: ['Space'],                 cat: 'transport', label: 'Play / pause' },
  { keys: ['K'],             codes: ['KeyK'],                  cat: 'transport', label: 'Pause / stop shuttle' },
  { keys: ['J'],             codes: ['KeyJ'],                  cat: 'transport', label: 'Shuttle reverse (tap for 2×, 4×)' },
  { keys: ['L'],             codes: ['KeyL'],                  cat: 'transport', label: 'Shuttle forward (tap for 2×, 4×)' },
  { keys: ['←'],             codes: ['ArrowLeft'],             cat: 'transport', label: 'Step back 1 frame' },
  { keys: ['→'],             codes: ['ArrowRight'],            cat: 'transport', label: 'Step forward 1 frame' },
  { keys: [','],             codes: ['Comma'],                 cat: 'transport', label: 'Step back 1 frame (alt)' },
  { keys: ['.'],             codes: ['Period'],                cat: 'transport', label: 'Step forward 1 frame (alt)' },
  { keys: ['⇧','←'],         codes: ['ShiftLeft','ArrowLeft'], cat: 'transport', label: 'Jump back 1 second' },
  { keys: ['⇧','→'],         codes: ['ShiftLeft','ArrowRight'],cat: 'transport', label: 'Jump forward 1 second' },

  // Marking
  { keys: ['I'],             codes: ['KeyI'],                  cat: 'marking', label: 'Mark in' },
  { keys: ['O'],             codes: ['KeyO'],                  cat: 'marking', label: 'Mark out' },
  { keys: ['G'],             codes: ['KeyG'],                  cat: 'marking', label: 'Clear both in and out' },
  { keys: ['⇧','I'],         codes: ['ShiftLeft','KeyI'],      cat: 'marking', label: 'Clear in only' },
  { keys: ['⇧','O'],         codes: ['ShiftLeft','KeyO'],      cat: 'marking', label: 'Clear out only' },
  { keys: ['X'],             codes: ['KeyX'],                  cat: 'marking', label: 'Mark whole clip (in=0, out=end)' },

  // Navigation
  { keys: ['Q'],             codes: ['KeyQ'],                  cat: 'navigation', label: 'Go to in point' },
  { keys: ['W'],             codes: ['KeyW'],                  cat: 'navigation', label: 'Go to out point' },
  { keys: ['Home'],          codes: ['Home'],                  cat: 'navigation', label: 'Go to clip start' },
  { keys: ['End'],           codes: ['End'],                   cat: 'navigation', label: 'Go to clip end' },
  { keys: ['⌘','←'],         codes: ['MetaLeft','ArrowLeft'],  cat: 'navigation', label: 'Previous keyframe' },
  { keys: ['⌘','→'],         codes: ['MetaLeft','ArrowRight'], cat: 'navigation', label: 'Next keyframe' },

  // Source / URL
  { keys: ['⌘','L'],         codes: ['MetaLeft','KeyL'],       cat: 'source', label: 'Focus URL field' },
  { keys: ['⌘','V'],         codes: ['MetaLeft','KeyV'],       cat: 'source', label: 'Paste source URL (when focused)' },
  { keys: ['⌘','↩'],         codes: ['MetaLeft','Enter'],      cat: 'source', label: 'Fetch source' },

  // Export
  { keys: ['⌥','E'],         codes: ['AltLeft','KeyE'],        cat: 'export', label: 'Export clip' },
  { keys: ['⌘','⇧','E'],     codes: ['MetaLeft','ShiftLeft','KeyE'], cat: 'export', label: 'Export with dialog' },
  { keys: ['⌘','R'],         codes: ['MetaLeft','KeyR'],       cat: 'export', label: 'Reveal last export in Finder' },

  // Window
  { keys: ['⌘','B'],         codes: ['MetaLeft','KeyB'],       cat: 'window', label: 'Toggle left sidebar' },
  { keys: ['⌘','\\'],        codes: ['MetaLeft','Backslash'],  cat: 'window', label: 'Toggle logs panel' },
  { keys: ['⌘',','],         codes: ['MetaLeft','Comma'],      cat: 'window', label: 'Open settings' },
  { keys: ['Esc'],           codes: ['Escape'],                cat: 'window', label: 'Close modal / cancel' },
];

// ============================================================
// VISUAL KEYBOARD
// ============================================================
// Mac-style compact ANSI layout. Each key has a code that lines up with
// KeyboardEvent.code; modifiers use Left variants. The cat for a key is
// inferred from SHORTCUTS so we don't duplicate categorisation.
const KB_LAYOUT = [
  // Row 1: numbers
  [
    { code: 'Backquote',    glyph: '`',  w: 1 },
    { code: 'Digit1',       glyph: '1',  w: 1 },
    { code: 'Digit2',       glyph: '2',  w: 1 },
    { code: 'Digit3',       glyph: '3',  w: 1 },
    { code: 'Digit4',       glyph: '4',  w: 1 },
    { code: 'Digit5',       glyph: '5',  w: 1 },
    { code: 'Digit6',       glyph: '6',  w: 1 },
    { code: 'Digit7',       glyph: '7',  w: 1 },
    { code: 'Digit8',       glyph: '8',  w: 1 },
    { code: 'Digit9',       glyph: '9',  w: 1 },
    { code: 'Digit0',       glyph: '0',  w: 1 },
    { code: 'Minus',        glyph: '−',  w: 1 },
    { code: 'Equal',        glyph: '=',  w: 1 },
    { code: 'Backspace',    glyph: '⌫',  w: 1.5 },
  ],
  // Row 2: qwerty
  [
    { code: 'Tab',          glyph: '⇥',  w: 1.5 },
    { code: 'KeyQ',         glyph: 'Q',  w: 1 },
    { code: 'KeyW',         glyph: 'W',  w: 1 },
    { code: 'KeyE',         glyph: 'E',  w: 1 },
    { code: 'KeyR',         glyph: 'R',  w: 1 },
    { code: 'KeyT',         glyph: 'T',  w: 1 },
    { code: 'KeyY',         glyph: 'Y',  w: 1 },
    { code: 'KeyU',         glyph: 'U',  w: 1 },
    { code: 'KeyI',         glyph: 'I',  w: 1 },
    { code: 'KeyO',         glyph: 'O',  w: 1 },
    { code: 'KeyP',         glyph: 'P',  w: 1 },
    { code: 'BracketLeft',  glyph: '[',  w: 1 },
    { code: 'BracketRight', glyph: ']',  w: 1 },
    { code: 'Backslash',    glyph: '\\', w: 1 },
  ],
  // Row 3: home row
  [
    { code: 'CapsLock',     glyph: '⇪',  w: 1.75 },
    { code: 'KeyA',         glyph: 'A',  w: 1 },
    { code: 'KeyS',         glyph: 'S',  w: 1 },
    { code: 'KeyD',         glyph: 'D',  w: 1 },
    { code: 'KeyF',         glyph: 'F',  w: 1 },
    { code: 'KeyG',         glyph: 'G',  w: 1 },
    { code: 'KeyH',         glyph: 'H',  w: 1 },
    { code: 'KeyJ',         glyph: 'J',  w: 1 },
    { code: 'KeyK',         glyph: 'K',  w: 1 },
    { code: 'KeyL',         glyph: 'L',  w: 1 },
    { code: 'Semicolon',    glyph: ';',  w: 1 },
    { code: 'Quote',        glyph: "'",  w: 1 },
    { code: 'Enter',        glyph: '↩',  w: 2.25 },
  ],
  // Row 4: shift + zxcv
  [
    { code: 'ShiftLeft',    glyph: '⇧',  w: 2.25, smallLabel: 'shift' },
    { code: 'KeyZ',         glyph: 'Z',  w: 1 },
    { code: 'KeyX',         glyph: 'X',  w: 1 },
    { code: 'KeyC',         glyph: 'C',  w: 1 },
    { code: 'KeyV',         glyph: 'V',  w: 1 },
    { code: 'KeyB',         glyph: 'B',  w: 1 },
    { code: 'KeyN',         glyph: 'N',  w: 1 },
    { code: 'KeyM',         glyph: 'M',  w: 1 },
    { code: 'Comma',        glyph: ',',  w: 1 },
    { code: 'Period',       glyph: '.',  w: 1 },
    { code: 'Slash',        glyph: '/',  w: 1 },
    { code: 'ShiftRight',   glyph: '⇧',  w: 2.75 },
  ],
  // Row 5: bottom modifiers + space
  [
    { code: 'Fn',           glyph: 'fn', w: 1 },
    { code: 'ControlLeft',  glyph: '⌃',  w: 1, smallLabel: 'control' },
    { code: 'AltLeft',      glyph: '⌥',  w: 1, smallLabel: 'option' },
    { code: 'MetaLeft',     glyph: '⌘',  w: 1.25, smallLabel: 'command' },
    { code: 'Space',        glyph: '',   w: 6.25 },
    { code: 'MetaRight',    glyph: '⌘',  w: 1.25, smallLabel: 'command' },
    { code: 'AltRight',     glyph: '⌥',  w: 1, smallLabel: 'option' },
    { code: 'ArrowLeft',    glyph: '←',  w: 1 },
    { code: 'ArrowUpDown',  glyph: 'arr',w: 1, isArrowCol: true },
    { code: 'ArrowRight',   glyph: '→',  w: 1 },
  ],
];

// Build a map { code -> {category, hasShortcut, label} } from SHORTCUTS so
// we can paint the keyboard.
function buildKbIndex(activeCodes) {
  const idx = {};
  for (const s of SHORTCUTS) {
    for (const c of s.codes) {
      if (!idx[c]) idx[c] = { cats: new Set() };
      idx[c].cats.add(s.cat);
    }
  }
  const out = {};
  Object.keys(idx).forEach((c) => {
    // primary category for stripe = first one that appears (priority order)
    const order = ['transport','marking','navigation','source','export','window'];
    const cat = order.find((o) => idx[c].cats.has(o));
    out[c] = { hasShortcut: true, cat };
  });
  // active = currently highlighted (from hover or live press)
  for (const c of (activeCodes || [])) {
    out[c] = { ...(out[c] || {}), active: true };
  }
  return out;
}

function VisualKeyboard({ activeCodes }) {
  const idx = buildKbIndex(activeCodes);

  return (
    <div className="kb-wrap">
      <div className="kb">
        {KB_LAYOUT.map((row, ri) => (
          <div className="kb-row" key={ri}>
            {row.map((k) => {
              if (k.isArrowCol) {
                // Stack ↑ over ↓ in one column
                const upActive = !!idx['ArrowUp']?.active;
                const dnActive = !!idx['ArrowDown']?.active;
                return (
                  <div key={k.code} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div
                      className={
                        'kb-key' +
                        (idx['ArrowUp']?.hasShortcut ? ' has-shortcut assigned-' + idx['ArrowUp'].cat : '') +
                        (upActive ? ' active' : '')
                      }
                      style={{ height: 17, minWidth: 36, width: 36 }}
                    >
                      <span className="glyph" style={{ fontSize: 9 }}>↑</span>
                    </div>
                    <div
                      className={
                        'kb-key' +
                        (idx['ArrowDown']?.hasShortcut ? ' has-shortcut assigned-' + idx['ArrowDown'].cat : '') +
                        (dnActive ? ' active' : '')
                      }
                      style={{ height: 17, minWidth: 36, width: 36 }}
                    >
                      <span className="glyph" style={{ fontSize: 9 }}>↓</span>
                    </div>
                  </div>
                );
              }
              const meta = idx[k.code] || {};
              const wClass = 'kb-w-' + String(k.w);
              return (
                <div
                  key={k.code}
                  className={
                    'kb-key ' + wClass +
                    (meta.hasShortcut ? ' has-shortcut assigned-' + meta.cat : '') +
                    (meta.active ? ' active' : '')
                  }
                  data-code={k.code}
                >
                  {k.smallLabel && k.w >= 1.25 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1, gap: 1 }}>
                      <span className="glyph">{k.glyph}</span>
                      <span className="glyph small" style={{ fontSize: 8, color: 'var(--fg-5)' }}>{k.smallLabel}</span>
                    </div>
                  ) : (
                    <span className="glyph">{k.glyph}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="kb-legend">
        <span className="pip transport"><span className="dot" /> Transport</span>
        <span className="pip marking"><span className="dot" /> Marking</span>
        <span className="pip navigation"><span className="dot" /> Navigation</span>
        <span className="pip source"><span className="dot" /> Source</span>
        <span className="pip export-cat"><span className="dot" /> Export</span>
        <span className="pip window-cat"><span className="dot" /> Window</span>
      </div>
    </div>
  );
}

// ============================================================
// SHORTCUTS PANE
// ============================================================
function ShortcutsPane() {
  const [hoverCodes, setHoverCodes] = React.useState([]);
  const [livePress, setLivePress] = React.useState([]);

  // Live-press: highlight keys the user actually presses while the modal is open.
  React.useEffect(() => {
    const onDown = (e) => {
      setLivePress((p) => p.includes(e.code) ? p : [...p, e.code]);
    };
    const onUp = (e) => {
      setLivePress((p) => p.filter((c) => c !== e.code));
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  const active = [...new Set([...hoverCodes, ...livePress])];

  const cats = [
    { id: 'transport',  label: 'Transport' },
    { id: 'marking',    label: 'Marking' },
    { id: 'navigation', label: 'Navigation' },
    { id: 'source',     label: 'Source' },
    { id: 'export',     label: 'Export' },
    { id: 'window',     label: 'Window' },
  ];

  return (
    <>
      <h2 className="cp-pane-title">Keyboard shortcuts</h2>
      <p className="cp-pane-sub">
        ClipPull's transport mirrors Premiere and Avid muscle memory — J/K/L shuttle, I/O mark, G clears.
        Hover a shortcut to highlight its keys, or just press a key and watch the board light up.
      </p>

      <VisualKeyboard activeCodes={active} />

      <div className="kb-shortcuts">
        {cats.map((c) => {
          const items = SHORTCUTS.filter((s) => s.cat === c.id);
          return (
            <div className={'kb-cat ' + (c.id === 'export' ? 'export-cat' : c.id === 'window' ? 'window-cat' : c.id)} key={c.id}>
              <div className="kb-cat-title">
                <span className="swatch" />
                {c.label}
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-5)', letterSpacing: '0.04em' }}>
                  {items.length}
                </span>
              </div>
              {items.map((s, i) => (
                <div
                  key={i}
                  className="kb-sc"
                  onMouseEnter={() => setHoverCodes(s.codes)}
                  onMouseLeave={() => setHoverCodes([])}
                >
                  <div className="label">{s.label}</div>
                  <div className="keys">
                    {s.keys.map((k, j) => (
                      <span key={j} className={'kbd' + (k.length > 1 ? ' sym' : '')}>{k}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ============================================================
// GENERAL PANE
// ============================================================
function GeneralPane() {
  const [launch, setLaunch] = React.useState(true);
  const [menubar, setMenubar] = React.useState(false);
  const [updateChan, setUpdateChan] = React.useState('stable');
  const [tele, setTele] = React.useState(false);

  return (
    <>
      <h2 className="cp-pane-title">General</h2>
      <p className="cp-pane-sub">Application behavior, appearance, and update preferences.</p>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Startup</div>
        <div className="cp-pane-row">
          <div className="k">
            Launch at login
            <span className="desc">Open ClipPull in the background when you log in.</span>
          </div>
          <div className="v">
            <div className={'cp-toggle-switch' + (launch ? ' on' : '')} onClick={() => setLaunch(!launch)} />
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Menubar mode
            <span className="desc">Hide the dock icon — accept URLs from a tiny menubar item.</span>
          </div>
          <div className="v">
            <div className={'cp-toggle-switch' + (menubar ? ' on' : '')} onClick={() => setMenubar(!menubar)} />
          </div>
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Updates</div>
        <div className="cp-pane-row">
          <div className="k">
            Release channel
            <span className="desc">"Beta" gets new resolvers a week before stable.</span>
          </div>
          <div className="v">
            <div className="cp-select" style={{ width: 180 }}>
              <select value={updateChan} onChange={(e) => setUpdateChan(e.target.value)}>
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
                <option value="nightly">Nightly</option>
              </select>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Anonymous telemetry
            <span className="desc">Resolver success rates only. Never URLs, never filenames.</span>
          </div>
          <div className="v">
            <div className={'cp-toggle-switch' + (tele ? ' on' : '')} onClick={() => setTele(!tele)} />
          </div>
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Locale</div>
        <div className="cp-pane-row">
          <div className="k">Language</div>
          <div className="v">
            <div className="cp-select" style={{ width: 180 }}>
              <select defaultValue="en-US">
                <option value="en-US">English (US)</option>
                <option value="en-GB">English (UK)</option>
                <option value="fr-FR">Français</option>
                <option value="de-DE">Deutsch</option>
                <option value="ja-JP">日本語</option>
              </select>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">Timecode standard</div>
          <div className="v">
            <div className="cp-select" style={{ width: 180 }}>
              <select defaultValue="non-drop">
                <option value="non-drop">Non-drop · HH:MM:SS:FF</option>
                <option value="drop">Drop frame · HH;MM;SS;FF</option>
                <option value="seconds">Seconds · HH:MM:SS.mmm</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// SOURCES PANE
// ============================================================
function SourcesPane() {
  const sources = [
    { name: 'YouTube',     short: 'YT', status: 'live',  desc: 'Up to 4K · Opus + AAC'},
    { name: 'Vimeo',       short: 'V',  status: 'live',  desc: 'OAuth · private clips'},
    { name: 'Twitter / X', short: 'X',  status: 'live',  desc: 'Up to 1080p'},
    { name: 'Twitch',      short: 'Tv', status: 'live',  desc: 'VODs · clips · 60fps'},
    { name: 'Facebook',    short: 'Fb', status: 'warn',  desc: 'Cookies required'},
    { name: 'Instagram',   short: 'Ig', status: 'live',  desc: 'Posts · reels'},
    { name: 'TikTok',      short: 'Tk', status: 'live',  desc: 'Watermark removal'},
    { name: 'Reddit',      short: 'R',  status: 'live',  desc: 'v.redd.it + crossposts'},
    { name: 'Direct mp4',  short: '.', status: 'live',  desc: 'Any HTTP(S) media URL'},
  ];
  return (
    <>
      <h2 className="cp-pane-title">Sources</h2>
      <p className="cp-pane-sub">
        ClipPull supports any site yt-dlp can resolve — these are the platforms we test on every release.
      </p>
      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Supported · {sources.length}</div>
        <div className="cp-sources">
          {sources.map((s) => (
            <div className="cp-source-card" key={s.name}>
              <div className="logo">{s.short}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{s.name}</div>
                <div className={'status' + (s.status === 'warn' ? ' warn' : s.status === 'off' ? ' off' : '')}>
                  <span className="pulse" />
                  {s.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Authentication</div>
        <div className="cp-pane-row">
          <div className="k">
            Browser cookie source
            <span className="desc">Read login cookies from your browser to access private clips.</span>
          </div>
          <div className="v">
            <div className="cp-select" style={{ width: 180 }}>
              <select defaultValue="chrome">
                <option value="none">None</option>
                <option value="chrome">Chrome</option>
                <option value="safari">Safari</option>
                <option value="firefox">Firefox</option>
                <option value="arc">Arc</option>
              </select>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Region (geo unblock)
            <span className="desc">Route through a proxy when an asset is region-locked.</span>
          </div>
          <div className="v">
            <div className="cp-select" style={{ width: 180 }}>
              <select defaultValue="auto">
                <option value="auto">Automatic</option>
                <option value="us">United States</option>
                <option value="eu">Europe</option>
                <option value="jp">Japan</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// EXPORT DEFAULTS PANE
// ============================================================
function ExportPane() {
  const [postAction, setPostAction] = React.useState('reveal');
  const [naming, setNaming] = React.useState('{platform}-{title}-{date}');
  const [overwrite, setOverwrite] = React.useState(false);
  const [meta, setMeta] = React.useState(true);

  return (
    <>
      <h2 className="cp-pane-title">Export defaults</h2>
      <p className="cp-pane-sub">
        These values populate the Export panel for every new source. Per-clip overrides are always allowed.
      </p>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Format</div>
        <div className="cp-pane-row">
          <div className="k">Default quality</div>
          <div className="v">
            <div className="cp-segmented" style={{ width: 280 }}>
              {['4K','1080p','720p','Audio'].map((q, i) => (
                <button key={q} className={i === 1 ? 'active' : ''}>{q}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">Video codec</div>
          <div className="v">
            <div className="cp-select" style={{ width: 220 }}>
              <select defaultValue="h264">
                <option value="h264">H.264 — libx264 (compat)</option>
                <option value="prores">ProRes 422 — editorial</option>
                <option value="dnxhr">DNxHR HQ</option>
                <option value="hevc">HEVC — libx265</option>
              </select>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">Container</div>
          <div className="v">
            <div className="cp-select" style={{ width: 220 }}>
              <select defaultValue="mp4">
                <option value="mp4">MP4 · faststart</option>
                <option value="mov">MOV · QuickTime</option>
                <option value="mkv">MKV · Matroska</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Output</div>
        <div className="cp-pane-row">
          <div className="k">
            Default folder
            <span className="desc">Where exported clips are saved unless overridden per-clip.</span>
          </div>
          <div className="v">
            <div className="cp-folder" style={{ width: 320 }}>
              <span className="path">~/Documents/Footage/2026/</span>
              <button>Browse</button>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Naming template
            <span className="desc">Variables: {`{platform} {title} {date} {in} {out} {uploader}`}</span>
          </div>
          <div className="v">
            <input
              className="cp-input"
              style={{ width: 320, fontFamily: 'var(--font-mono)' }}
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
            />
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">Post-export action</div>
          <div className="v">
            <div className="cp-select" style={{ width: 220 }}>
              <select value={postAction} onChange={(e) => setPostAction(e.target.value)}>
                <option value="reveal">Reveal in Finder</option>
                <option value="copy">Copy file path</option>
                <option value="open">Open in default player</option>
                <option value="nothing">Do nothing</option>
              </select>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Overwrite existing files
            <span className="desc">When off, ClipPull appends a counter: -1, -2, -3.</span>
          </div>
          <div className="v">
            <div className={'cp-toggle-switch' + (overwrite ? ' on' : '')} onClick={() => setOverwrite(!overwrite)} />
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Embed source metadata
            <span className="desc">Title, uploader, original URL written to QuickTime tags.</span>
          </div>
          <div className="v">
            <div className={'cp-toggle-switch' + (meta ? ' on' : '')} onClick={() => setMeta(!meta)} />
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// PIPELINE PANE
// ============================================================
function PipelinePane() {
  return (
    <>
      <h2 className="cp-pane-title">Pipeline</h2>
      <p className="cp-pane-sub">
        Low-level controls for the tools ClipPull shells out to. Most users never touch this — but it's here when you need it.
      </p>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Resolvers</div>
        <div className="cp-pane-row">
          <div className="k">yt-dlp binary</div>
          <div className="v">
            <div className="cp-folder" style={{ width: 380 }}>
              <span className="path">~/Library/App Support/ClipPull/bin/yt-dlp · 2026.05.01</span>
              <button>Update</button>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">ffmpeg binary</div>
          <div className="v">
            <div className="cp-folder" style={{ width: 380 }}>
              <span className="path">/opt/homebrew/bin/ffmpeg · 7.1 (with librav1e)</span>
              <button>Browse</button>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Custom yt-dlp args
            <span className="desc">Appended to every resolve. Use with care.</span>
          </div>
          <div className="v">
            <input className="cp-input" style={{ width: 380, fontFamily: 'var(--font-mono)' }} placeholder="--no-mtime --embed-chapters" />
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Custom ffmpeg args
            <span className="desc">Appended after Mark in/out but before output path.</span>
          </div>
          <div className="v">
            <input className="cp-input" style={{ width: 380, fontFamily: 'var(--font-mono)' }} placeholder="-movflags +faststart -metadata title='…'" />
          </div>
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Concurrency</div>
        <div className="cp-pane-row">
          <div className="k">
            Parallel exports
            <span className="desc">How many ffmpeg jobs may run at once.</span>
          </div>
          <div className="v">
            <div className="cp-select" style={{ width: 100 }}>
              <select defaultValue="2">
                <option>1</option><option>2</option><option>4</option><option>8</option>
              </select>
            </div>
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Network proxy
            <span className="desc">HTTP/SOCKS proxy for resolver only.</span>
          </div>
          <div className="v">
            <input className="cp-input" style={{ width: 320, fontFamily: 'var(--font-mono)' }} placeholder="socks5://127.0.0.1:1080" />
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// ABOUT PANE
// ============================================================
function AboutPane() {
  return (
    <>
      <h2 className="cp-pane-title">About</h2>
      <p className="cp-pane-sub">A tiny professional source-acquisition tool — built for documentary editors and the people who pull their plates.</p>

      <div className="cp-about-hero">
        <div className="mark">c.</div>
        <div style={{ flex: 1 }}>
          <div className="name">clippull <span className="ver">v1.4.2 · build 2026.05.21</span></div>
          <div className="tag">Editorial source acquisition for macOS · 14.0+</div>
        </div>
        <button className="btn btn-ghost">Check for updates</button>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Build</div>
        <div className="cp-about-grid">
          <div className="row"><span className="k">App</span><span className="v">1.4.2 (2026.05.21)</span></div>
          <div className="row"><span className="k">Tauri</span><span className="v">2.4.0</span></div>
          <div className="row"><span className="k">yt-dlp</span><span className="v">2026.05.01</span></div>
          <div className="row"><span className="k">ffmpeg</span><span className="v">7.1 + librav1e</span></div>
          <div className="row"><span className="k">Codesign</span><span className="v">Developer ID · notarized</span></div>
          <div className="row"><span className="k">Architecture</span><span className="v">universal (arm64 / x86_64)</span></div>
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Credits</div>
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.6, margin: 0 }}>
          ClipPull rides on the shoulders of <span style={{ color: 'var(--fg-1)' }}>yt-dlp</span>, <span style={{ color: 'var(--fg-1)' }}>ffmpeg</span>, and <span style={{ color: 'var(--fg-1)' }}>Tauri</span>.
          Designed in dialogue with documentary editors at Atelier Cascade, the New School, and the Cinéma du réel residency.
        </p>
      </div>
    </>
  );
}

// ============================================================
// MODAL SHELL
// ============================================================
const SETTINGS_TABS = [
  { id: 'general',   label: 'General',         iconKey: 'settings', Component: GeneralPane },
  { id: 'sources',   label: 'Sources',         iconKey: 'link',     Component: SourcesPane },
  { id: 'export',    label: 'Export defaults', iconKey: 'film',     Component: ExportPane },
  { id: 'shortcuts', label: 'Shortcuts',       iconKey: 'kbd',      Component: ShortcutsPane },
  { id: 'pipeline',  label: 'Pipeline',        iconKey: 'pipe',     Component: PipelinePane },
  { id: 'about',     label: 'About',           iconKey: 'about',    Component: AboutPane },
];

function TabIcon({ k }) {
  const common = { className: 'tab-icon' };
  switch (k) {
    case 'settings': return <IconSettings size={14} {...common} />;
    case 'link':     return <IconLink size={14} {...common} />;
    case 'film':     return <IconFilm size={14} {...common} />;
    case 'kbd':
      return (
        <svg className="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <line x1="6" y1="10" x2="6" y2="10" />
          <line x1="10" y1="10" x2="10" y2="10" />
          <line x1="14" y1="10" x2="14" y2="10" />
          <line x1="18" y1="10" x2="18" y2="10" />
          <line x1="7" y1="14" x2="17" y2="14" />
        </svg>
      );
    case 'pipe':
      return (
        <svg className="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h11a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4H10a4 4 0 0 0-4 4v0" />
          <path d="M3 6h.01" />
          <path d="M6 18h.01" />
        </svg>
      );
    case 'about':
      return (
        <svg className="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <line x1="12" y1="8" x2="12" y2="8" />
        </svg>
      );
    default: return null;
  }
}

function SettingsModal({ open, onClose }) {
  const [tab, setTab] = React.useState('shortcuts');

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const Pane = SETTINGS_TABS.find((t) => t.id === tab)?.Component || GeneralPane;
  const currentLabel = SETTINGS_TABS.find((t) => t.id === tab)?.label || '';

  return (
    <div className="cp-modal-backdrop" onClick={onClose}>
      <div className="cp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cp-modal-header">
          <IconSettings size={14} stroke="var(--fg-3)" />
          <h2 style={{ marginLeft: 8 }}>Settings</h2>
          <span className="crumb">{currentLabel}</span>
          <div className="filler" />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-5)', marginRight: 12 }}>
            ⌘,
          </span>
          <button className="cp-modal-close" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>
        <div className="cp-modal-body">
          <div className="cp-modal-tabs">
            <div className="cp-modal-tabs-section">Application</div>
            {SETTINGS_TABS.slice(0, 3).map((t) => (
              <button key={t.id} className={'cp-modal-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
                <TabIcon k={t.iconKey} />
                <span className="grow">{t.label}</span>
              </button>
            ))}
            <div className="cp-modal-tabs-section">Workflow</div>
            {SETTINGS_TABS.slice(3, 5).map((t) => (
              <button key={t.id} className={'cp-modal-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
                <TabIcon k={t.iconKey} />
                <span className="grow">{t.label}</span>
                {t.id === 'shortcuts' && (
                  <span className="count">{SHORTCUTS.length}</span>
                )}
              </button>
            ))}
            <div className="cp-modal-tabs-section">System</div>
            {SETTINGS_TABS.slice(5).map((t) => (
              <button key={t.id} className={'cp-modal-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
                <TabIcon k={t.iconKey} />
                <span className="grow">{t.label}</span>
              </button>
            ))}
          </div>
          <div className="cp-modal-content">
            <Pane />
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { SettingsModal });
