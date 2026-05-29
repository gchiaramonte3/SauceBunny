// logs.jsx — bottom collapsible logs panel, ffmpeg/yt-dlp aesthetic

function LogLine({ ts, tag, tagClass, msg }) {
  return (
    <div className="log-line">
      <span className="ts">{ts}</span>
      <span className={'tag ' + (tagClass || 'info')}>{tag}</span>
      <span className="msg" dangerouslySetInnerHTML={{ __html: msg }} />
    </div>
  );
}

function LogsPanel({ open, onToggle, status, exportProgress, lines }) {
  const bodyRef = React.useRef(null);

  React.useEffect(() => {
    if (bodyRef.current && open) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, open]);

  const statusPill = (() => {
    if (status === 'fetching') return { label: 'RESOLVING', cls: 'working' };
    if (status === 'exporting') return { label: 'CUTTING · FFMPEG', cls: 'working' };
    if (status === 'success') return { label: 'OK', cls: 'success' };
    if (status === 'error')   return { label: 'ERROR', cls: 'error' };
    if (status === 'loaded')  return { label: 'READY', cls: '' };
    return { label: 'IDLE', cls: '' };
  })();

  const showProgress = status === 'fetching' || status === 'exporting';

  return (
    <div className={'cp-logs ' + (open ? 'open' : 'collapsed')}>
      <div className="cp-logs-header" onClick={onToggle}>
        <IconChevronDown size={11} className="chev" style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        <span className="title">Pipeline</span>
        <span className={'status-pill ' + statusPill.cls}>{statusPill.label}</span>
        {showProgress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${exportProgress}%` }} />
          </div>
        )}
        <div className="filler" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-5)' }}>
          yt-dlp 2026.05.01 · ffmpeg 7.1 · librav1e
        </span>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button>Copy</button>
          <button>Clear</button>
        </div>
      </div>
      {open && (
        <div className="cp-logs-body" ref={bodyRef}>
          {lines.map((l, i) => (
            <LogLine
              key={i}
              ts={l.ts}
              tag={l.tag}
              tagClass={l.tagClass}
              msg={l.msg}
            />
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { LogsPanel });
