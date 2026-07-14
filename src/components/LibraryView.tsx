/**
 * Home view — the Library. Phase-1 STUB: an empty-state panel that reserves
 * the view while the real library (folder scan, media grid, its own header)
 * lands in phase 3. Rendered inside the always-mounted view container in
 * App.tsx; the Clip view keeps playing underneath while this is on screen.
 */
export function LibraryView() {
  return (
    <div className="cp-library">
      <div className="cp-library-empty">
        <h1 className="cp-library-title">Your library</h1>
        <p className="cp-library-hint">
          Browse everything you&rsquo;ve pulled, transcribed, and reviewed — all in one place.
        </p>
        <button type="button" className="btn" disabled title="Coming in the next build">
          Add a folder
        </button>
      </div>
    </div>
  );
}
