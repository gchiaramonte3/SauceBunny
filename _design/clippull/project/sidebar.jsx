// sidebar.jsx — left sidebar: source metadata + export panel + recents
// Each section has a chevron header so users can collapse it.

const { useState: useStateS } = React;

function CollapsibleSection({ id, label, meta, defaultOpen = true, openMap, setOpenMap, children, summary }) {
  const open = openMap[id] !== false;
  const toggle = () => setOpenMap({ ...openMap, [id]: !open });
  return (
    <div className={'cp-section collapsible' + (open ? '' : ' collapsed')}>
      <div className="cp-section-head" onClick={toggle}>
        <IconChevronDown size={11} className="chev" />
        <span className="label">{label}</span>
        <span className="meta">{open ? meta : (summary || meta)}</span>
      </div>
      <div className="cp-section-body">
        {children}
      </div>
    </div>
  );
}

function SidebarEmpty() {
  return (
    <div className="cp-section">
      <div className="cp-section-label">Source</div>
      <div className="cp-thumb" style={{ background: '#0A0A0D', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <IconFilm size={22} stroke="rgba(255,255,255,0.18)" />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--fg-5)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            No source loaded
          </span>
        </div>
      </div>
      <div className="cp-meta">
        <h2 style={{ color: 'var(--fg-4)' }}>Waiting for source…</h2>
        <div className="cp-meta-row">
          <span style={{ color: 'var(--fg-5)' }}>Paste a URL above to begin</span>
        </div>
      </div>
    </div>
  );
}

function SourceBody({ src }) {
  return (
    <>
      <div className="cp-thumb">
        <img src={src.thumbnail} alt="" />
        <div className="dur-pill">{src.duration}</div>
      </div>
      <div className="cp-meta">
        <h2>{src.title}</h2>
        <div className="cp-meta-row">
          <span>{src.uploader}</span>
          <span className="sep" />
          <span>{src.uploaded}</span>
          <span className="sep" />
          <span>{src.views}</span>
        </div>
      </div>
      <div className="cp-kv">
        <div className="k">Resolution</div>
        <div className="v">{src.resolution}</div>
        <div className="k">Framerate</div>
        <div className="v mono">{src.framerate}</div>
        <div className="k">Codec</div>
        <div className="v mono">{src.codec}</div>
        <div className="k">Streams</div>
        <div className="v mono">{src.streams}</div>
      </div>
    </>
  );
}

function ExportBody({ src, exportOpts, setExportOpts, onExport, status, onReveal }) {
  const set = (k, v) => setExportOpts({ ...exportOpts, [k]: v });
  const exporting = status === 'exporting';
  const success = status === 'success';

  const formats = [
    { id: '4k',   label: '4K' },
    { id: '1080', label: '1080p' },
    { id: '720',  label: '720p' },
    { id: 'audio',label: 'Audio' },
  ];

  return (
    <>
      <div className="cp-field-row">
        <div className="cp-field">
          <label>Mark in</label>
          <div className="cp-input-wrap">
            <input
              type="text"
              className="cp-input with-suffix"
              value={exportOpts.in}
              onChange={(e) => set('in', e.target.value)}
            />
            <span className="cp-input-suffix">in</span>
          </div>
        </div>
        <div className="cp-field">
          <label>Mark out</label>
          <div className="cp-input-wrap">
            <input
              type="text"
              className="cp-input with-suffix"
              value={exportOpts.out}
              onChange={(e) => set('out', e.target.value)}
            />
            <span className="cp-input-suffix">out</span>
          </div>
        </div>
      </div>

      <div className="cp-field" style={{ marginTop: -4, marginBottom: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--fg-3)',
        }}>
          <span style={{ color: 'var(--fg-4)', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, fontWeight: 600 }}>Selection</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
            {exportOpts.selectionDur}
          </span>
        </div>
      </div>

      <div className="cp-field">
        <label>Filename</label>
        <div className="cp-input-wrap">
          <input
            type="text"
            className="cp-input with-suffix"
            value={exportOpts.filename}
            onChange={(e) => set('filename', e.target.value)}
            style={{ fontFamily: 'var(--font-ui)' }}
          />
          <span className="cp-input-suffix">.{exportOpts.container}</span>
        </div>
      </div>

      <div className="cp-field">
        <label>Output folder</label>
        <div className="cp-folder">
          <span className="path">{exportOpts.folder}</span>
          <button>Browse</button>
        </div>
      </div>

      <div className="cp-field" style={{ marginBottom: 10 }}>
        <label>Format / quality</label>
        <div className="cp-segmented">
          {formats.map((f) => (
            <button
              key={f.id}
              className={exportOpts.format === f.id ? 'active' : ''}
              onClick={() => set('format', f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cp-toggle">
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <IconCaptions size={13} stroke="var(--fg-3)" />
          Burn captions
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-5)', marginLeft: 2 }}>
            ({exportOpts.captionTrack})
          </span>
        </span>
        <div
          className={'cp-toggle-switch' + (exportOpts.captions ? ' on' : '')}
          onClick={() => set('captions', !exportOpts.captions)}
        />
      </div>
      <div className="cp-toggle">
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <IconFilm size={13} stroke="var(--fg-3)" />
          Re-encode (lossless cut off)
        </span>
        <div
          className={'cp-toggle-switch' + (exportOpts.reencode ? ' on' : '')}
          onClick={() => set('reencode', !exportOpts.reencode)}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        {success ? (
          <>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={onReveal}>
              <IconReveal size={13} />
              Reveal in Finder
            </button>
            <button className="btn btn-ghost" title="Export another">↻</button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            style={{ flex: 1, height: 36, fontSize: 13 }}
            onClick={onExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export clip'}
          </button>
        )}
      </div>
      {!success && !exporting && (
        <div style={{
          marginTop: 8,
          fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--fg-5)',
          textAlign: 'center', letterSpacing: '0.04em',
        }}>
          {exportOpts.format === 'audio' ? 'MP3 320 kbps · ' : ''}
          {exportOpts.format !== 'audio' ? `${exportOpts.container.toUpperCase()} · ` : ''}
          {exportOpts.format === '4k' ? '~ 412 MB' : exportOpts.format === '1080' ? '~ 184 MB' : exportOpts.format === '720' ? '~ 96 MB' : '~ 12 MB'}
        </div>
      )}
    </>
  );
}

function RecentBody({ recents, onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {recents.map((r) => (
        <div className="cp-recent" key={r.id} onClick={() => onPick?.(r)}>
          <div className="thumb">
            <img src={r.thumb} alt="" />
          </div>
          <div className="body">
            <div className="title">{r.title}</div>
            <div className="meta">
              <span className="tc">{r.dur}</span>
              <span className="sep" />
              <span>{r.when}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Sidebar({ status, src, exportOpts, setExportOpts, onExport, recents, onReveal }) {
  // Persist collapsed state of each section in localStorage so it survives
  // refreshes (common when iterating).
  const [openMap, setOpenMap] = useStateS(() => {
    try {
      const stored = localStorage.getItem('cp-sidebar-sections');
      if (stored) return JSON.parse(stored);
    } catch {}
    return { source: true, export: true, recent: true };
  });
  React.useEffect(() => {
    try { localStorage.setItem('cp-sidebar-sections', JSON.stringify(openMap)); } catch {}
  }, [openMap]);

  if (status === 'empty' || status === 'fetching') {
    return (
      <aside className="cp-sidebar">
        <SidebarEmpty />
        <CollapsibleSection
          id="recent"
          label="Recent"
          meta={`${recents.length} clips`}
          openMap={openMap}
          setOpenMap={setOpenMap}
        >
          <RecentBody recents={recents} />
        </CollapsibleSection>
      </aside>
    );
  }

  return (
    <aside className="cp-sidebar">
      <CollapsibleSection
        id="source"
        label="Source"
        meta={src.platform}
        summary={src.platform + ' · ' + src.duration}
        openMap={openMap}
        setOpenMap={setOpenMap}
      >
        <SourceBody src={src} />
      </CollapsibleSection>

      <CollapsibleSection
        id="export"
        label="Export"
        meta={exportOpts.format === 'audio' ? 'MP3' : exportOpts.format.toUpperCase() + ' · MP4'}
        summary={exportOpts.selectionDur + ' selection'}
        openMap={openMap}
        setOpenMap={setOpenMap}
      >
        <ExportBody
          src={src}
          exportOpts={exportOpts}
          setExportOpts={setExportOpts}
          onExport={onExport}
          status={status}
          onReveal={onReveal}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id="recent"
        label="Recent"
        meta={`${recents.length} clips`}
        openMap={openMap}
        setOpenMap={setOpenMap}
      >
        <RecentBody recents={recents} />
      </CollapsibleSection>
    </aside>
  );
}

Object.assign(window, { Sidebar });
