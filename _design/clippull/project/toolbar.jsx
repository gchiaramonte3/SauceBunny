// toolbar.jsx — top toolbar: wordmark, URL field, Fetch, Settings

function ToolbarWordmark() {
  return (
    <div className="cp-wordmark">
      <span>clippull</span>
      <span className="dot" />
      <span className="cp-wordmark-sub">source acquisition</span>
    </div>
  );
}

function UrlField({ value, onChange, onPaste, onSubmit, status }) {
  const inputRef = React.useRef(null);

  const handleKey = (e) => {
    if (e.key === 'Enter') onSubmit?.();
  };

  return (
    <div className="cp-url">
      <IconLink size={14} stroke="var(--fg-4)" />
      <span className="scheme">https://</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder="paste a source URL — youtube, vimeo, twitter, direct mp4…"
        spellCheck={false}
      />
      <button
        className="btn-icon"
        style={{ width: 22, height: 22 }}
        title="Paste from clipboard"
        onClick={onPaste}
      >
        <IconClipboard size={13} />
      </button>
    </div>
  );
}

function Toolbar({ url, setUrl, onFetch, onPaste, status, onOpenSettings }) {
  const fetching = status === 'fetching';
  const fetchLabel = fetching ? 'Resolving…' : 'Fetch';
  return (
    <div className="cp-toolbar">
      <ToolbarWordmark />
      <UrlField
        value={url}
        onChange={setUrl}
        onPaste={onPaste}
        onSubmit={onFetch}
        status={status}
      />
      <button
        className="btn btn-ghost"
        onClick={onFetch}
        disabled={fetching || !url}
        style={{ minWidth: 86 }}
      >
        {fetchLabel}
      </button>
      <button className="btn-icon" title="Settings" onClick={onOpenSettings}>
        <IconSettings size={15} />
      </button>
    </div>
  );
}

Object.assign(window, { Toolbar });
