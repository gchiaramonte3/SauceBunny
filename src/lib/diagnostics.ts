/**
 * Diagnostics-report assembly — the no-telemetry answer to remote bug
 * reports. The Pipeline panel's "Export diagnostics" button saves this as a
 * plain-text file the user attaches to a bug report BY HAND; nothing is ever
 * sent anywhere. Everything in it is local: versions, the settings snapshot
 * (paths are the user's own machine — useful, not sensitive), and the recent
 * pipeline log.
 *
 * Pure functions (no invoke, no Date.now) so the exact output is unit-tested;
 * App.tsx gathers the inputs and writes the file via the save dialog.
 */

/** The pipeline-log fields the report prints — matches `ClientLog` minus id. */
export type DiagnosticsLogLine = {
  ts: string;      // HH:MM:SS
  tag: string;     // severity: info | ok | warn | err | muxer
  source: string;  // channel, e.g. "yt-dlp", "whisper"
  message: string;
};

export type DiagnosticsInput = {
  /** tauri.conf.json version via getVersion(), or "unknown". */
  appVersion: string;
  /** Frontend's EXPECTED_BACKEND_BUILD_ID. */
  expectedBuildId: string;
  /** get_backend_build_id result, or a short parenthesised reason it couldn't be read. */
  backendBuildId: string;
  /** navigator.userAgent — carries the macOS + WebKit versions. */
  userAgent: string;
  generatedAt: Date;
  /** Full persisted defaults snapshot. Secret-shaped keys are REDACTED by
   *  the printer (see SECRET_KEY_PATTERNS) - do not rely on callers to strip. */
  settings: Record<string, unknown>;
  /** Sidecar versions from existing commands (yt-dlp is the only one exposed today). */
  sidecars: { name: string; version: string }[];
  /** Full session log — the report keeps only the last DIAGNOSTICS_LOG_LIMIT lines. */
  logLines: DiagnosticsLogLine[];
  /** Live co-review state, when a session is running. Omitted when solo.
   *  This is the block that says WHICH MACHINE's picture is wrong: compare
   *  two reports side by side and a roster or floor disagreement is visible
   *  immediately, which is otherwise a two-machine guessing game. */
  session?: SessionDiagnostics;
};

export type SessionDiagnostics = {
  role: string;
  selfId: string | null;
  presenter: string;
  presenterEpoch: number;
  /** Roster as this machine sees it, with the epoch that decides staleness. */
  peers: { id: string; name: string; epoch: number }[];
  /** WebRTC state per peer: connecting / live / failed. */
  meshStates: { id: string; state: string }[];
  /** Whether a capture is open, and what it carries. */
  capture: string;
  shareState: string;
};

/** How many pipeline-log lines the report keeps (most recent last). */
export const DIAGNOSTICS_LOG_LIMIT = 300;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `saucebunny-diagnostics-YYYYMMDD-HHMM.txt`, local time. */
export function diagnosticsFilename(now: Date): string {
  return (
    `saucebunny-diagnostics-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}.txt`
  );
}

/**
 * Settings keys whose VALUE must never be written into a file the user is
 * told to email to a stranger. Redaction lives here, at the printer, rather
 * than at the call site: this report is assembled from a spread of the whole
 * persisted defaults object, so anything added to that object later would
 * otherwise be printed verbatim by default. The presence of the key is still
 * reported (it is diagnostically useful to know a relay is configured) - only
 * the value is replaced.
 *
 * Matching is case-insensitive substring, so a future `turnPassword2` or
 * `apiKeyBackup` is caught without anyone remembering to update this list.
 */
const SECRET_KEY_PATTERNS = ["password", "secret", "token", "apikey", "api_key", "credential"];

/**
 * Strip the query string off any URL in a log line.
 *
 * The settings block is scrubbed key by key. The log block was not scrubbed at
 * all, and it is the half carrying output from processes this app does not
 * write: yt-dlp's stdout and stderr are forwarded verbatim through
 * `playback-prep-log`. A signed CDN URL puts its credential in the QUERY
 * (`sig`, `expire`, and friends), and such a URL is a working, time-limited
 * grant to fetch that media for anyone holding it — in a file the app tells
 * the user to attach to a bug report.
 *
 * Scheme, host and path survive, because "it was fetching from
 * rr3---sn-x.googlevideo.com/videoplayback and got a 403" is the whole
 * diagnostic value of the line and none of the risk.
 *
 * What this does NOT do: find a secret that is not in a URL query. A header
 * dump or a printed cookie would still go through. Stated here rather than
 * implied, because the honest scope of a scrubber is the thing people get
 * wrong about scrubbers.
 */
export function redactLogLine(message: string): string {
  return message.replace(/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/g, "$1?<redacted>");
}

function redactSetting(key: string, value: unknown): string {
  const k = key.toLowerCase();
  if (SECRET_KEY_PATTERNS.some((p) => k.includes(p))) {
    const len = typeof value === "string" ? value.length : 0;
    return len > 0 ? `"<redacted, ${len} chars>"` : '""';
  }
  return JSON.stringify(value);
}

export function buildDiagnosticsReport(d: DiagnosticsInput): string {
  const out: string[] = [];
  const push = (s = "") => out.push(s);

  push("Sauce Bunny diagnostics report");
  push(`Generated: ${d.generatedAt.toISOString()}`);
  push("Attach this file to a bug report. It was assembled locally and never leaves your machine unless you send it.");
  push();

  push("== App ==");
  push(`App version:     ${d.appVersion}`);
  push(`Build (frontend): ${d.expectedBuildId}`);
  const buildNote = d.backendBuildId === d.expectedBuildId ? " (match)" : " (MISMATCH)";
  push(`Build (backend):  ${d.backendBuildId}${buildNote}`);
  push(`OS / WebView:    ${d.userAgent}`);
  push();

  push("== Settings ==");
  // Sorted for a stable, diffable report regardless of object insertion order.
  for (const key of Object.keys(d.settings).sort()) {
    push(`${key} = ${redactSetting(key, d.settings[key])}`);
  }
  push();

  push("== Sidecars ==");
  if (d.sidecars.length === 0) {
    push("(no sidecar versions available)");
  } else {
    for (const s of d.sidecars) push(`${s.name}: ${s.version}`);
  }
  push();

  if (d.session) {
    const s = d.session;
    push("== Co-review session ==");
    push(`Role:            ${s.role}`);
    push(`Self id:         ${s.selfId ?? "(none)"}`);
    push(`Presenter:       ${s.presenter} (epoch ${s.presenterEpoch})`);
    push(`Share state:     ${s.shareState}`);
    push(`Capture:         ${s.capture}`);
    push(`Roster (${s.peers.length}):`);
    if (s.peers.length === 0) {
      push("  (nobody)");
    } else {
      const mesh = new Map(s.meshStates.map((m) => [m.id, m.state]));
      for (const p of s.peers) {
        const self = p.id === s.selfId ? " <- this machine" : "";
        push(`  ${p.id} epoch=${p.epoch} rtc=${mesh.get(p.id) ?? "n/a"} "${p.name}"${self}`);
      }
    }
    push();
  }

  const tail = d.logLines.slice(-DIAGNOSTICS_LOG_LIMIT);
  const header = tail.length < d.logLines.length
    ? `last ${tail.length} of ${d.logLines.length} lines`
    : `${tail.length} line${tail.length === 1 ? "" : "s"}`;
  push(`== Pipeline log (${header}) ==`);
  if (tail.length === 0) {
    push("(empty)");
  } else {
    for (const l of tail) {
      push(`${l.ts} ${l.tag.padEnd(5)} ${l.source.padEnd(10)} ${redactLogLine(l.message)}`);
    }
  }
  push();

  return out.join("\n");
}
