import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import type { McpSetup } from "../bindings/McpSetup";
import { formatError } from "../lib/error-format";
import { IconAlert, IconCheck } from "./Icons";

/**
 * "Use Sauce Bunny from Claude": the app's MCP server (`sauce-bunny --mcp`,
 * src-tauri/src/mcp.rs) for Claude Code, Claude Desktop and other MCP apps.
 * Read-only: they can read sequences, transcripts and string outs, and change
 * nothing. What they read goes wherever that app sends it, which for Claude
 * is Anthropic, and that is said here rather than left to be discovered.
 */
export function AssistantAccess() {
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { invoke<McpSetup>("mcp_setup").then(setSetup).catch((cause) => setMsg({ ok: false, text: formatError(cause) })); }, []);
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text)
    .then(() => setMsg({ ok: true, text: `Copied the ${what}.` })).catch((cause) => setMsg({ ok: false, text: formatError(cause) }));
  const saveExtension = async () => {
    const path = await save({ defaultPath: "Sauce Bunny.mcpb", filters: [{ name: "Claude Desktop extension", extensions: ["mcpb"] }] });
    if (!path) return;
    try { await invoke<string>("mcp_save_extension", { path }); setMsg({ ok: true, text: "Saved. Open it to install Sauce Bunny in Claude Desktop." }); }
    catch (cause) { setMsg({ ok: false, text: formatError(cause) }); }
  };
  return (
    <div className="cp-aiapi-card">
      <div className="cp-aiapi-cardhead"><span className="cp-aiapi-name">Use Sauce Bunny from Claude</span></div>
      <p className="cp-aiapi-hints cp-assist-about">
        Claude Code, Claude Desktop and other MCP apps can read your sequences, transcripts and string outs, and change nothing.
        What they read goes wherever that app sends it: Claude sends it to Anthropic. The first time, macOS may ask to let that app see your Documents folder.
      </p>
      <label className="cp-aiapi-label" htmlFor="assist-claude-code">Claude Code</label>
      <div className="cp-aiapi-row">
        <input id="assist-claude-code" className="cp-aiapi-input cp-assist-command" readOnly value={setup?.claude_code ?? ""} spellCheck={false} />
        <button type="button" className="btn btn-ghost" disabled={!setup} onClick={() => setup && copy(setup.claude_code, "Claude Code command")}>Copy</button>
      </div>
      <span className="cp-aiapi-label">Claude Desktop</span>
      <div className="cp-aiapi-row">
        <button type="button" className="btn" disabled={!setup} onClick={() => void saveExtension()}>Save extension…</button>
        <button type="button" className="btn btn-ghost" disabled={!setup} onClick={() => setup && copy(setup.desktop_config, "Claude Desktop config")}>Copy config</button>
      </div>
      {msg && <p className={"cp-aiapi-msg" + (msg.ok ? " ok" : " err")} role={msg.ok ? "status" : "alert"}>
        {msg.ok ? <IconCheck size={12} /> : <IconAlert size={12} />} {msg.text}</p>}
    </div>
  );
}
