// app.jsx — main ClipPull application: state machine, keyboard, tweaks

const { useState, useEffect, useRef, useCallback } = React;

// ============================================================
// SOURCE DATA — a cinematic B-roll clip in the monitor
// ============================================================
const SRC = {
  platform: 'youtube',
  title: 'Eastern Sierra — sunrise plate, RED Komodo 6K · roll 14',
  uploader: 'Atelier Cascade',
  uploaded: 'Apr 24, 2026',
  views: '38.2K views',
  duration: '00:14:32:11',
  resolution: '3840 × 2160',
  framerate: '23.976 fps',
  codec: 'AVC · HEVC',
  streams: 'video + audio + 2 subs',
  remaining: '00:13:49:18',
  thumbnail: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=720&q=80&auto=format&fit=crop',
  preview: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1800&q=85&auto=format&fit=crop',
};

const RECENTS = [
  {
    id: 'r1',
    title: 'Mojave dunes — magic hour ext.',
    dur: '00:04:18',
    when: '2h ago',
    thumb: 'https://images.unsplash.com/photo-1473580044384-7ba9967e16a0?w=320&q=80&auto=format&fit=crop',
  },
  {
    id: 'r2',
    title: 'Reykjavík harbor — int. fisherman',
    dur: '00:01:42',
    when: 'yesterday',
    thumb: 'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=320&q=80&auto=format&fit=crop',
  },
  {
    id: 'r3',
    title: 'Marfa night sky — timelapse, 8s',
    dur: '00:00:08',
    when: 'Mon',
    thumb: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=320&q=80&auto=format&fit=crop',
  },
  {
    id: 'r4',
    title: 'Kyoto rain — handheld, A7s III',
    dur: '00:02:55',
    when: 'May 12',
    thumb: 'https://images.unsplash.com/photo-1492571350019-22de08371fd3?w=320&q=80&auto=format&fit=crop',
  },
];

// ============================================================
// TIMECODE HELPERS — frames @ 24fps, HH:MM:SS:FF
// ============================================================
const FPS = 24;
const framesToTc = (f) => {
  const total = Math.max(0, f);
  const hh = Math.floor(total / (FPS * 3600));
  const mm = Math.floor((total % (FPS * 3600)) / (FPS * 60));
  const ss = Math.floor((total % (FPS * 60)) / FPS);
  const ff = Math.floor(total % FPS);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}:${String(ff).padStart(2,'0')}`;
};
const tcToFrames = (tc) => {
  const parts = (tc || '').split(':').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts;
  return ((hh * 3600 + mm * 60 + ss) * FPS) + ff;
};
const DURATION_FRAMES = tcToFrames('00:14:32:11');

// ============================================================
// MOCK LOG STREAMS
// ============================================================
const FETCH_LOGS = [
  { ts: '08:14:22', tag: 'yt-dlp', tagClass: 'info', msg: 'Extracting URL: <span class="dim">https://youtube.com/watch?v=…</span>' },
  { ts: '08:14:22', tag: 'yt-dlp', tagClass: 'info', msg: 'Downloading webpage' },
  { ts: '08:14:23', tag: 'yt-dlp', tagClass: 'info', msg: 'Downloading player <span class="dim">14e8d6b7</span>' },
  { ts: '08:14:23', tag: 'yt-dlp', tagClass: 'info', msg: 'Downloading m3u8 manifest <span class="dim">(adaptive)</span>' },
  { ts: '08:14:24', tag: 'probe',  tagClass: 'muxer', msg: 'Found <span class="num">7</span> formats · best video <span class="num">2160p60</span> · best audio <span class="num">opus 160k</span>' },
  { ts: '08:14:24', tag: 'ok',     tagClass: 'ok',    msg: 'Source resolved · stream selected: <span class="num">313+251</span> · 14m32s @ 23.976' },
];
const EXPORT_LOGS = [
  { ts: '08:16:02', tag: 'cut',    tagClass: 'info',  msg: 'Selection <span class="num">00:00:42:11 → 00:02:14:09</span> · 01:31:22 (2188 frames)' },
  { ts: '08:16:02', tag: 'ffmpeg', tagClass: 'muxer', msg: 'Stream copy disabled · re-encode AVC → AVC <span class="dim">(keyframe alignment)</span>' },
  { ts: '08:16:03', tag: 'ffmpeg', tagClass: 'muxer', msg: '<span class="dim">-c:v libx264 -crf 18 -preset slower -c:a aac -b:a 192k</span>' },
  { ts: '08:16:04', tag: 'frame',  tagClass: 'info',  msg: 'frame=<span class="num">240</span> fps=<span class="num">96</span> q=21.0 size=<span class="num">14.2MB</span> bitrate=<span class="num">12.4Mb/s</span> speed=<span class="num">4.01x</span>' },
  { ts: '08:16:06', tag: 'frame',  tagClass: 'info',  msg: 'frame=<span class="num">720</span> fps=<span class="num">112</span> q=20.0 size=<span class="num">38.8MB</span> bitrate=<span class="num">11.9Mb/s</span> speed=<span class="num">4.66x</span>' },
  { ts: '08:16:09', tag: 'frame',  tagClass: 'info',  msg: 'frame=<span class="num">1440</span> fps=<span class="num">118</span> q=19.0 size=<span class="num">76.4MB</span> bitrate=<span class="num">12.1Mb/s</span> speed=<span class="num">4.91x</span>' },
  { ts: '08:16:14', tag: 'frame',  tagClass: 'info',  msg: 'frame=<span class="num">2188</span> fps=<span class="num">119</span> q=-1.0 Lsize=<span class="num">183.6MB</span> bitrate=<span class="num">12.3Mb/s</span> speed=<span class="num">4.96x</span>' },
  { ts: '08:16:14', tag: 'mux',    tagClass: 'muxer', msg: 'Muxing audio (AAC 192k stereo) · faststart · metadata stripped' },
  { ts: '08:16:14', tag: 'ok',     tagClass: 'ok',    msg: 'Wrote <span class="num">~/Footage/Cascade-Sierra-sunrise.mp4</span> · 184 MB · SHA1 <span class="dim">b14e…3f02</span>' },
];
const IDLE_LOGS = [
  { ts: '—',        tag: 'idle',  tagClass: 'info', msg: 'Awaiting source. Logs will populate during fetch and export.' },
];
const ERROR_LOGS = [
  { ts: '08:14:22', tag: 'yt-dlp', tagClass: 'info', msg: 'Extracting URL: <span class="dim">https://youtube.com/watch?v=…</span>' },
  { ts: '08:14:22', tag: 'yt-dlp', tagClass: 'info', msg: 'Downloading webpage' },
  { ts: '08:14:23', tag: 'warn',   tagClass: 'warn', msg: 'Received HTTP 403 · retrying with cookie jar' },
  { ts: '08:14:24', tag: 'warn',   tagClass: 'warn', msg: 'Received HTTP 403 · retrying with rotated client' },
  { ts: '08:14:25', tag: 'err',    tagClass: 'err',  msg: 'Unable to resolve source stream · upstream returned 403 after 3 attempts. The asset may be region-locked.' },
];

// ============================================================
// TWEAK DEFAULTS (persisted)
// Hex values map back to semantic keys ('green' / 'purple' / 'orange')
// via the lookup below for CSS data-attributes.
// ============================================================
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "appState": "loaded",
  "density": "comfortable",
  "logsOpen": true,
  "accentColor": "#6CFF8D",
  "markerColor": "#E87826",
  "aspectGuide": "off",
  "showSidebar": true,
  "windowChrome": true
}/*EDITMODE-END*/;

const ACCENT_TO_KEY = { '#6CFF8D': 'green', '#B084FF': 'purple' };
const MARKER_TO_KEY = { '#6CFF8D': 'green', '#B084FF': 'purple', '#E87826': 'orange' };

// ============================================================
// MAIN APP
// ============================================================
function ClipPullApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Sync URL state for the toolbar
  const [url, setUrl] = useState('youtube.com/watch?v=8nWcCkfTaUk');

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Status drives all visual states. We mirror t.appState so changing the tweak swaps states instantly.
  const [status, setStatus] = useState(t.appState);
  useEffect(() => { setStatus(t.appState); }, [t.appState]);

  // Playback state
  const [playheadFrames, setPlayheadFrames] = useState(tcToFrames('00:01:23:18'));
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuttle, setShuttle] = useState(0); // -1, 0, 1
  const [inFrames, setInFrames] = useState(tcToFrames('00:00:42:11'));
  const [outFrames, setOutFrames] = useState(tcToFrames('00:02:14:09'));

  // Export state
  const [exportOpts, setExportOpts] = useState({
    in: framesToTc(tcToFrames('00:00:42:11')),
    out: framesToTc(tcToFrames('00:02:14:09')),
    selectionDur: framesToTc(tcToFrames('00:02:14:09') - tcToFrames('00:00:42:11')),
    filename: 'Cascade-Sierra-sunrise',
    container: 'mp4',
    folder: '~/Documents/Footage/2026 · Atelier Cascade /Plates/',
    format: '1080',
    captions: false,
    captionTrack: 'en · auto',
    reencode: true,
  });
  // Keep in/out + container in sync between timeline and the export panel
  useEffect(() => {
    setExportOpts((p) => ({
      ...p,
      in: framesToTc(inFrames),
      out: framesToTc(outFrames),
      selectionDur: framesToTc(Math.max(0, outFrames - inFrames)),
    }));
  }, [inFrames, outFrames]);

  // Audio-only sets container → mp3
  useEffect(() => {
    setExportOpts((p) => ({ ...p, container: p.format === 'audio' ? 'mp3' : 'mp4' }));
  }, [exportOpts.format]);

  // Export progress
  const [exportProgress, setExportProgress] = useState(0);
  useEffect(() => {
    if (status === 'exporting') {
      setExportProgress(0);
      const startedAt = Date.now();
      const id = setInterval(() => {
        const pct = Math.min(100, Math.floor((Date.now() - startedAt) / 35));
        setExportProgress(pct);
        if (pct >= 100) {
          clearInterval(id);
          setTimeout(() => {
            setStatus('success');
            setTweak('appState', 'success');
          }, 400);
        }
      }, 80);
      return () => clearInterval(id);
    }
  }, [status]);

  // Auto-advance from 'fetching' to 'loaded' after a short delay
  useEffect(() => {
    if (status === 'fetching') {
      const id = setTimeout(() => {
        setStatus('loaded');
        setTweak('appState', 'loaded');
      }, 1800);
      return () => clearTimeout(id);
    }
  }, [status]);

  // Playback tick
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      setPlayheadFrames((f) => {
        const next = f + (shuttle === 0 ? 1 : shuttle * 2);
        if (next >= DURATION_FRAMES) { setIsPlaying(false); return DURATION_FRAMES - 1; }
        if (next < 0) { setIsPlaying(false); return 0; }
        return next;
      });
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, [isPlaying, shuttle]);

  // Actions
  const onFetch = useCallback(() => {
    if (!url) return;
    setStatus('fetching');
    setTweak('appState', 'fetching');
  }, [url]);

  const onPaste = useCallback(async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) setUrl(txt.replace(/^https?:\/\//, ''));
    } catch {
      // no-op
    }
  }, []);

  const onPlayToggle = useCallback(() => {
    if (status !== 'loaded' && status !== 'exporting') return;
    setIsPlaying((p) => !p);
  }, [status]);

  const onMarkIn = useCallback(() => setInFrames(Math.min(playheadFrames, outFrames - FPS)), [playheadFrames, outFrames]);
  const onMarkOut = useCallback(() => setOutFrames(Math.max(playheadFrames, inFrames + FPS)), [playheadFrames, inFrames]);
  const onClearIn = useCallback(() => setInFrames(0), []);
  const onClearOut = useCallback(() => setOutFrames(DURATION_FRAMES - 1), []);
  const onClearMarks = useCallback(() => {
    setInFrames(0);
    setOutFrames(DURATION_FRAMES - 1);
  }, []);
  const onMarkClip = useCallback(() => {
    setInFrames(0);
    setOutFrames(DURATION_FRAMES - 1);
  }, []);
  const onGotoIn = useCallback(() => setPlayheadFrames(inFrames), [inFrames]);
  const onGotoOut = useCallback(() => setPlayheadFrames(outFrames), [outFrames]);
  const onStep = useCallback((delta) => setPlayheadFrames((f) => Math.max(0, Math.min(DURATION_FRAMES - 1, f + delta))), []);
  const onShuttle = useCallback((dir) => {
    setShuttle(dir);
    if (dir === 0) setIsPlaying(false);
    else setIsPlaying(true);
  }, []);
  const onSeek = useCallback((f) => setPlayheadFrames(Math.max(0, Math.min(DURATION_FRAMES - 1, f))), []);

  const onExport = useCallback(() => {
    setStatus('exporting');
    setTweak('appState', 'exporting');
  }, []);
  const onReveal = useCallback(() => {
    // no-op; for demo
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      const cmd = e.metaKey || e.ctrlKey;
      // Cmd+, → open settings (don't run if settings already open)
      if (cmd && e.key === ',') { e.preventDefault(); setSettingsOpen(true); return; }
      // Cmd+B → toggle sidebar
      if (cmd && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); setTweak('showSidebar', !t.showSidebar); return; }
      // Cmd+\ → toggle logs panel
      if (cmd && e.key === '\\') { e.preventDefault(); setTweak('logsOpen', !t.logsOpen); return; }
      // Cmd+L → focus URL (we just no-op visually here)
      // Cmd+Enter → fetch
      if (cmd && e.key === 'Enter') { e.preventDefault(); onFetch(); return; }
      // Alt+E → export
      if (e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); if (status === 'loaded') onExport(); return; }
      // Escape → close settings
      if (e.key === 'Escape') {
        if (settingsOpen) { setSettingsOpen(false); return; }
      }

      // Don't take transport keys while modal is open
      if (settingsOpen) return;

      switch (e.key) {
        case ' ': e.preventDefault(); onPlayToggle(); break;
        case 'k': case 'K': setShuttle(0); setIsPlaying((p) => !p); break;
        case 'j': case 'J': onShuttle(-1); break;
        case 'l': case 'L': onShuttle(1); break;
        case 'i': case 'I':
          if (e.shiftKey) onClearIn();
          else onMarkIn();
          break;
        case 'o': case 'O':
          if (e.shiftKey) onClearOut();
          else onMarkOut();
          break;
        case 'g': case 'G': onClearMarks(); break;
        case 'x': case 'X': onMarkClip(); break;
        case 'q': case 'Q': onGotoIn(); break;
        case 'w': case 'W': onGotoOut(); break;
        case ',': onStep(e.shiftKey ? -FPS : -1); break;
        case '.': onStep(e.shiftKey ?  FPS :  1); break;
        case 'Home': onSeek(0); break;
        case 'End': onSeek(DURATION_FRAMES - 1); break;
        case 'ArrowLeft':  onStep(e.shiftKey ? -FPS : -1); break;
        case 'ArrowRight': onStep(e.shiftKey ?  FPS :  1); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPlayToggle, onShuttle, onMarkIn, onMarkOut, onClearIn, onClearOut, onClearMarks, onMarkClip, onGotoIn, onGotoOut, onStep, onSeek, status, settingsOpen, t.showSidebar, t.logsOpen, onFetch, onExport]);

  // Pick logs to display
  const lines = (() => {
    if (status === 'fetching') return FETCH_LOGS.slice(0, 5);
    if (status === 'loaded')   return [...FETCH_LOGS];
    if (status === 'exporting')return [...FETCH_LOGS, ...EXPORT_LOGS.slice(0, 4)];
    if (status === 'success')  return [...FETCH_LOGS, ...EXPORT_LOGS];
    if (status === 'error')    return ERROR_LOGS;
    return IDLE_LOGS;
  })();

  // Apply data-attributes on root
  useEffect(() => {
    const r = document.documentElement;
    r.dataset.accent = ACCENT_TO_KEY[t.accentColor] || 'green';
    r.dataset.marker = MARKER_TO_KEY[t.markerColor] || 'orange';
    r.dataset.density = t.density;
  }, [t.accentColor, t.markerColor, t.density]);

  const showWindow = t.windowChrome;

  // ============================================================
  // RENDER
  // ============================================================
  const appBody = (
    <>
      <Toolbar
        url={url}
        setUrl={setUrl}
        onFetch={onFetch}
        onPaste={onPaste}
        status={status}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="cp-body">
        {t.showSidebar && (
          <Sidebar
            status={status}
            src={SRC}
            exportOpts={exportOpts}
            setExportOpts={setExportOpts}
            onExport={onExport}
            onReveal={onReveal}
            recents={RECENTS}
          />
        )}
        <main className="cp-main">
          <div className="cp-monitor-wrap">
            <Monitor
              status={status}
              src={SRC}
              exportOpts={exportOpts}
              aspectGuide={t.aspectGuide}
              playhead={framesToTc(playheadFrames)}
              isPlaying={isPlaying}
              exportProgress={exportProgress}
              onReveal={onReveal}
            />
            <Transport
              status={status}
              isPlaying={isPlaying}
              onPlayToggle={onPlayToggle}
              playhead={framesToTc(playheadFrames)}
              duration={SRC.duration}
              onMarkIn={onMarkIn}
              onMarkOut={onMarkOut}
              shuttle={shuttle}
              onShuttle={onShuttle}
              onStep={onStep}
            />
            <Timeline
              status={status}
              durationFrames={DURATION_FRAMES}
              playheadFrames={playheadFrames}
              inFrames={inFrames}
              outFrames={outFrames}
              onSeek={onSeek}
              src={SRC}
            />
            <KeyboardHints />
          </div>
          <LogsPanel
            open={t.logsOpen}
            onToggle={() => setTweak('logsOpen', !t.logsOpen)}
            status={status}
            exportProgress={exportProgress}
            lines={lines}
          />
        </main>
      </div>
    </>
  );

  return (
    <>
      {showWindow ? (
        <div className="cp-window">
          <div className="cp-titlebar">
            <div className="cp-traffic">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
            <div className="cp-titlebar-title">ClipPull — Cascade-Sierra-sunrise</div>
          </div>
          {appBody}
          <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </div>
      ) : (
        <div className="cp-window" style={{ width: '100vw', height: '100vh', borderRadius: 0, boxShadow: 'none' }}>
          {appBody}
          <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </div>
      )}
      <ClipPullTweaks t={t} setTweak={setTweak} />
    </>
  );
}

// ============================================================
// TWEAKS PANEL
// ============================================================
function ClipPullTweaks({ t, setTweak }) {
  return (
    <TweaksPanel title="ClipPull Tweaks">
      <TweakSection label="App state" />
      <TweakSelect
        label="State"
        value={t.appState}
        onChange={(v) => setTweak('appState', v)}
        options={[
          { value: 'empty',     label: 'Empty — no source' },
          { value: 'fetching',  label: 'Fetching — resolving' },
          { value: 'loaded',    label: 'Loaded — ready to cut' },
          { value: 'exporting', label: 'Exporting — ffmpeg' },
          { value: 'success',   label: 'Success — clip written' },
          { value: 'error',     label: 'Error — resolve failed' },
        ]}
      />

      <TweakSection label="Layout" />
      <TweakRadio
        label="Density"
        value={t.density}
        onChange={(v) => setTweak('density', v)}
        options={[
          { value: 'comfortable', label: 'Comfy' },
          { value: 'compact',     label: 'Compact' },
        ]}
      />
      <TweakToggle
        label="Sidebar"
        value={t.showSidebar}
        onChange={(v) => setTweak('showSidebar', v)}
      />
      <TweakToggle
        label="Window chrome"
        value={t.windowChrome}
        onChange={(v) => setTweak('windowChrome', v)}
      />
      <TweakToggle
        label="Logs panel open"
        value={t.logsOpen}
        onChange={(v) => setTweak('logsOpen', v)}
      />

      <TweakSection label="Accent" />
      <TweakColor
        label="Brand accent"
        value={t.accentColor}
        onChange={(v) => setTweak('accentColor', v)}
        options={['#6CFF8D', '#B084FF']}
      />
      <TweakColor
        label="In/Out markers"
        value={t.markerColor}
        onChange={(v) => setTweak('markerColor', v)}
        options={['#E87826', '#6CFF8D', '#B084FF']}
      />

      <TweakSection label="Monitor" />
      <TweakSelect
        label="Aspect guide"
        value={t.aspectGuide}
        onChange={(v) => setTweak('aspectGuide', v)}
        options={[
          { value: 'off',  label: 'Off' },
          { value: '16:9', label: '16 : 9 — broadcast' },
          { value: '2.39', label: '2.39 : 1 — anamorphic' },
          { value: '1:1',  label: '1 : 1 — square' },
          { value: '9:16', label: '9 : 16 — vertical' },
        ]}
      />
    </TweaksPanel>
  );
}

// Mount
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ClipPullApp />);
