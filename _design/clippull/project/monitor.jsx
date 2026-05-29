// monitor.jsx — main source monitor: video preview + transport + timeline

// ============================================================
// CROP GUIDES
// ============================================================
function CropGuide({ aspect }) {
  if (!aspect || aspect === 'off') return null;
  const labelMap = {
    '16:9': '16 : 9',
    '9:16': '9 : 16',
    '1:1':  '1 : 1',
    '2.39': '2.39 : 1',
  };
  // Container is 16:9 by default. Compute guide rect.
  // We render as percentages of the container.
  let style = {};
  if (aspect === '16:9') {
    style = { left: 0, right: 0, top: 0, bottom: 0 };
  } else if (aspect === '9:16') {
    // 9:16 inside 16:9 → vertical strip, width = 9/16 * height aspect
    // container is 16:9. A 9:16 frame at full height is 9*(9/16)/16 = (9/16)/(16/9) = 0.3164 of width
    const w = (9 / 16) / (16 / 9) * 100; // 31.64
    const inset = (100 - w) / 2;
    style = { left: `${inset}%`, right: `${inset}%`, top: 0, bottom: 0 };
  } else if (aspect === '1:1') {
    // 1:1 at full height → width = height = container_height. In 16:9, w = 9/16 = 56.25% of width.
    const w = (1) / (16 / 9) * 100; // 56.25
    const inset = (100 - w) / 2;
    style = { left: `${inset}%`, right: `${inset}%`, top: 0, bottom: 0 };
  } else if (aspect === '2.39') {
    // 2.39:1 inside 16:9 → height = w / 2.39, h_ratio = (16/9)/2.39 = 0.744. So height = 74.4% of container height
    const h = ((16 / 9) / 2.39) * 100;
    const inset = (100 - h) / 2;
    style = { top: `${inset}%`, bottom: `${inset}%`, left: 0, right: 0 };
  }
  return (
    <div className="cp-guide" style={style}>
      <div className="cp-guide-label">{labelMap[aspect]}</div>
    </div>
  );
}

// ============================================================
// MONITOR
// ============================================================
function Monitor({
  status, src, exportOpts,
  aspectGuide,
  playhead, isPlaying,
  exportProgress,
  onReveal,
}) {
  if (status === 'empty') {
    return (
      <div className="cp-monitor">
        <div className="cp-empty">
          <div className="cp-empty-perf">
            <span /><span /><span /><span /><span /><span /><span /><span />
          </div>
          <h3>Paste a source URL</h3>
          <p>Drop a link in the field above to load a clip. ClipPull resolves the highest quality stream and never touches host branding.</p>
        </div>
      </div>
    );
  }

  if (status === 'fetching') {
    return (
      <div className="cp-monitor">
        <div className="cp-fetching">
          <div className="cp-scanline" />
          <div className="status">RESOLVING SOURCE STREAM…</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-5)', letterSpacing: '0.06em' }}>
            yt-dlp · probing manifests · 4 of 7 formats found
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="cp-monitor">
        <img className="cp-monitor-img" src={src.preview} alt="" style={{ filter: 'grayscale(0.6) brightness(0.4)' }} />
        <div className="cp-error-overlay">
          <div className="icon"><IconAlert size={20} /></div>
          <div className="label">Unable to resolve source stream</div>
          <div className="detail">HTTP 403 · region-locked · try a proxy or a different mirror</div>
        </div>
      </div>
    );
  }

  return (
    <div className="cp-monitor">
      <img className="cp-monitor-img" src={src.preview} alt={src.title} />

      <CropGuide aspect={aspectGuide} />

      <div className="cp-monitor-overlay">
        <div className="row">
          <div className="tl">
            <div className="badge">
              <span className="live-dot" />
              Source · {src.platform}
            </div>
          </div>
          <div className="tr">
            <div className="badge">{src.resolution} · {src.framerate}</div>
          </div>
        </div>
        <div className="row">
          <div className="bl">
            <div className="tc-overlay">{playhead}</div>
          </div>
          <div className="br">
            <div className="tc-overlay" style={{ color: 'var(--fg-3)' }}>− {src.remaining}</div>
          </div>
        </div>
      </div>

      {status === 'exporting' && (
        <div style={{
          position: 'absolute', left: 14, right: 14, bottom: 36,
          height: 28, display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 12px',
          background: 'rgba(0,0,0,0.72)',
          backdropFilter: 'blur(10px)',
          borderRadius: 4,
          fontFamily: 'var(--font-mono)', fontSize: 11,
          color: 'var(--fg-1)', letterSpacing: '0.04em',
        }}>
          <span style={{ color: 'var(--accent)' }}>● REC</span>
          <span style={{ color: 'var(--fg-3)' }}>Cutting {exportOpts.in} → {exportOpts.out}</span>
          <div style={{
            flex: 1,
            height: 2,
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 1,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${exportProgress}%`,
              height: '100%',
              background: 'var(--accent)',
              boxShadow: '0 0 6px rgba(var(--accent-rgb), 0.5)',
              transition: 'width 200ms linear',
            }} />
          </div>
          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>{exportProgress}%</span>
        </div>
      )}

      {status === 'success' && (
        <div className="cp-success-overlay">
          <div className="check"><IconCheck size={28} /></div>
          <div className="label">Clip exported</div>
          <div className="meta">{exportOpts.filename}.{exportOpts.container} · 184 MB · 00:48:12 elapsed</div>
          <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={onReveal}>
            <IconReveal size={13} />
            Reveal in Finder
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// TRANSPORT
// ============================================================
function Transport({ status, isPlaying, onPlayToggle, playhead, duration, onMarkIn, onMarkOut, shuttle, onShuttle, onStep }) {
  const dim = status === 'empty' || status === 'fetching' || status === 'error';
  return (
    <div className="cp-transport" style={{ opacity: dim ? 0.5 : 1, pointerEvents: dim ? 'none' : 'auto' }}>
      <div className="cp-tc-stack">
        <span className="cp-tc-label">Position</span>
        <div className="cp-tc">{playhead}</div>
      </div>

      <div className="cp-transport-controls">
        <button className="cp-transport-btn" title="Step back 1f (←)" onClick={() => onStep?.(-1)}>
          <IconSkipBack size={13} />
        </button>
        <button
          className={'cp-transport-btn play' + (isPlaying ? ' active' : '')}
          title="Play / pause (K, Space)"
          onClick={onPlayToggle}
        >
          {isPlaying ? <IconPause size={14} /> : <IconPlay size={13} />}
        </button>
        <button className="cp-transport-btn" title="Step forward 1f (→)" onClick={() => onStep?.(1)}>
          <IconSkipForward size={13} />
        </button>

        <div className="cp-shuttle" title="Shuttle (J / K / L)">
          <button className={shuttle === -1 ? 'active' : ''} onClick={() => onShuttle?.(-1)}>J</button>
          <button className={shuttle ===  0 ? 'active' : ''} onClick={() => onShuttle?.( 0)}>K</button>
          <button className={shuttle ===  1 ? 'active' : ''} onClick={() => onShuttle?.( 1)}>L</button>
        </div>
      </div>

      <button className="cp-mark-btn" onClick={onMarkIn} title="Mark in (I)">
        <span className="mark-dot" />
        Mark in
        <span className="kbd">I</span>
      </button>
      <button className="cp-mark-btn" onClick={onMarkOut} title="Mark out (O)">
        <span className="mark-dot out" />
        Mark out
        <span className="kbd">O</span>
      </button>

      <div style={{ flex: 1 }} />

      <div className="cp-tc-stack" style={{ alignItems: 'flex-end' }}>
        <span className="cp-tc-label">Duration</span>
        <div className="cp-tc duration">{duration}</div>
      </div>
    </div>
  );
}

// ============================================================
// TIMELINE
// ============================================================
function Timeline({ status, durationFrames, playheadFrames, inFrames, outFrames, onSeek, src }) {
  const trackRef = React.useRef(null);
  const dim = status === 'empty' || status === 'fetching' || status === 'error';

  const handleClick = (e) => {
    if (!trackRef.current || dim) return;
    const r = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onSeek?.(Math.floor(ratio * durationFrames));
  };

  const pct = (f) => (f / durationFrames) * 100;

  // Ruler ticks — every ~10% of width, with TC labels in src timecode space.
  const ticks = [];
  if (!dim) {
    const N = 10;
    for (let i = 0; i <= N; i++) {
      ticks.push(i);
    }
  }
  // Convert frames to HH:MM:SS for ruler labels
  const tcAt = (frames) => {
    if (!src) return '';
    const fps = 24;
    const totalSec = Math.floor(frames / fps);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="cp-timeline" style={{ opacity: dim ? 0.3 : 1 }}>
      <div className="cp-timeline-ruler">
        {ticks.map((i) => {
          const left = (i / 10) * 100;
          const frames = Math.floor((i / 10) * durationFrames);
          const major = i % 2 === 0;
          return (
            <React.Fragment key={i}>
              <div
                className={'tick ' + (major ? 'major' : 'minor')}
                style={{ left: `${left}%` }}
              />
              {major && (
                <div className="tick-label" style={{ left: `${left}%` }}>
                  {tcAt(frames)}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="cp-track" ref={trackRef} onClick={handleClick}>
        <div className="cp-track-fill" style={{ left: 0, right: 0 }} />
        {!dim && (
          <>
            <div
              className="cp-track-selection"
              style={{
                left: `${pct(inFrames)}%`,
                width: `${pct(outFrames - inFrames)}%`,
              }}
            />
            <div
              className="cp-playhead"
              style={{ left: `${pct(playheadFrames)}%` }}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// KEYBOARD HINTS
// ============================================================
function KeyboardHints() {
  return (
    <div className="cp-hints">
      <div className="cp-hint"><span className="kbd">J</span><span className="kbd">K</span><span className="kbd">L</span> shuttle</div>
      <div className="cp-hint"><span className="kbd">I</span><span className="kbd">O</span> mark in/out</div>
      <div className="cp-hint"><span className="kbd">G</span> clear marks</div>
      <div className="cp-hint"><span className="kbd">Q</span><span className="kbd">W</span> go to in/out</div>
      <div className="cp-hint"><span className="kbd">,</span><span className="kbd">.</span> step 1f</div>
      <div className="cp-hint"><span className="kbd">Space</span> play / pause</div>
      <div style={{ flex: 1 }} />
      <div className="cp-hint"><span className="kbd">⌥</span><span className="kbd">E</span> export</div>
      <div className="cp-hint"><span className="kbd">⌘</span><span className="kbd">,</span> settings</div>
    </div>
  );
}

Object.assign(window, { Monitor, Transport, Timeline, KeyboardHints });
