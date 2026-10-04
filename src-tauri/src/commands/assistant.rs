//! Settings ▸ AI APIs ▸ "Use Sauce Bunny from Claude": how an MCP client
//! starts this app's MCP server (`sauce-bunny --mcp`, src/mcp.rs), as a
//! Claude Code command, a Claude Desktop config entry, and a Claude Desktop
//! extension (`.mcpb`) that installs it in one click.
//!
//! The extension is a zip of a manifest and a two-line launcher that runs
//! this executable where it is installed now, so it is written on demand
//! rather than shipped: an app moved out of /Applications still works once
//! the extension is saved again. The zip is written here, stored (no
//! compression), because a manifest and a script are a few hundred bytes and
//! a zip crate would be a dependency for that alone.
use crate::context::tools;
use crate::AppError;
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct McpSetup {
    /// This app's executable, which serves MCP with `--mcp`.
    pub command: String,
    /// The line to paste into a terminal for Claude Code.
    pub claude_code: String,
    /// The entry for `claude_desktop_config.json`, for anyone who adds servers by hand.
    pub desktop_config: String,
}

fn executable() -> Result<String, AppError> {
    let path = std::env::current_exe().map_err(|error| AppError::internal(format!("Could not find Sauce Bunny's executable: {error}")))?;
    Ok(std::fs::canonicalize(&path).unwrap_or(path).to_string_lossy().into_owned())
}

/// A path quoted for a POSIX shell: inside single quotes, a single quote is `'\''`.
fn quoted(path: &str) -> String { format!("'{}'", path.replace('\'', "'\\''")) }

fn setup_for(command: &str) -> McpSetup {
    McpSetup {
        command: command.to_string(),
        claude_code: format!("claude mcp add sauce-bunny -- {} --mcp", quoted(command)),
        desktop_config: serde_json::to_string_pretty(&json!({ "mcpServers": { "sauce-bunny": { "command": command, "args": ["--mcp"] } } })).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn mcp_setup() -> Result<McpSetup, AppError> { Ok(setup_for(&executable()?)) }

/// The extension's manifest (MCPB manifest 0.3), naming every tool and prompt.
fn manifest() -> serde_json::Value {
    json!({
        "manifest_version": "0.3", "name": "sauce-bunny", "display_name": "Sauce Bunny", "version": env!("CARGO_PKG_VERSION"),
        "description": "Read your Sauce Bunny sequences, transcripts and string outs.",
        "long_description": "Lets Claude read the AAF Audio sequences, per-mic transcripts, string outs and Transcripts library on this Mac, read-only. It runs the Sauce Bunny app installed here; what Claude reads goes to Anthropic with your conversation.",
        "author": { "name": "Sauce Bunny" }, "license": "MIT",
        "server": { "type": "binary", "entry_point": "server/sauce-bunny-mcp",
            "mcp_config": { "command": "/bin/sh", "args": ["${__dirname}/server/sauce-bunny-mcp"], "env": {} } },
        "tools": tools::TOOLS.iter().map(|tool| json!({ "name": tool.name, "description": tool.description })).collect::<Vec<_>>(),
        "prompts": tools::PROMPTS.iter().map(|prompt| json!({ "name": prompt.name, "description": prompt.description,
            "arguments": prompt.arguments.iter().map(|(name, _, _)| *name).collect::<Vec<_>>(), "text": prompt.description })).collect::<Vec<_>>(),
        "compatibility": { "platforms": ["darwin"] },
    })
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 { crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 }; }
    }
    !crc
}

/// A zip of stored files, each with its Unix mode.
fn zip(entries: &[(&str, Vec<u8>, u32)]) -> Vec<u8> {
    const DOS_DATE: u16 = 0x0021; // 1980-01-01, the earliest a zip can say
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data, mode) in entries {
        let (offset, crc, size) = (out.len() as u32, crc32(data), data.len() as u32);
        for part in [&0x0403_4b50u32.to_le_bytes()[..], &20u16.to_le_bytes(), &0u16.to_le_bytes(), &0u16.to_le_bytes(), &0u16.to_le_bytes(), &DOS_DATE.to_le_bytes(),
            &crc.to_le_bytes(), &size.to_le_bytes(), &size.to_le_bytes(), &(name.len() as u16).to_le_bytes(), &0u16.to_le_bytes(), name.as_bytes(), data] { out.extend_from_slice(part); }
        for part in [&0x0201_4b50u32.to_le_bytes()[..], &((3u16 << 8) | 20).to_le_bytes(), &20u16.to_le_bytes(), &0u16.to_le_bytes(), &0u16.to_le_bytes(), &0u16.to_le_bytes(),
            &DOS_DATE.to_le_bytes(), &crc.to_le_bytes(), &size.to_le_bytes(), &size.to_le_bytes(), &(name.len() as u16).to_le_bytes(), &0u16.to_le_bytes(), &0u16.to_le_bytes(),
            &0u16.to_le_bytes(), &0u16.to_le_bytes(), &(mode << 16).to_le_bytes(), &offset.to_le_bytes(), name.as_bytes()] { central.extend_from_slice(part); }
    }
    let (start, length, count) = (out.len() as u32, central.len() as u32, entries.len() as u16);
    out.extend_from_slice(&central);
    for part in [&0x0605_4b50u32.to_le_bytes()[..], &0u16.to_le_bytes(), &0u16.to_le_bytes(), &count.to_le_bytes(), &count.to_le_bytes(), &length.to_le_bytes(), &start.to_le_bytes(), &0u16.to_le_bytes()] {
        out.extend_from_slice(part);
    }
    out
}

fn extension(command: &str) -> Vec<u8> {
    let launcher = format!("#!/bin/sh\n# Sauce Bunny's MCP server: the app's own executable in --mcp mode, read-only.\nexec {} --mcp \"$@\"\n", quoted(command));
    zip(&[("manifest.json", serde_json::to_vec_pretty(&manifest()).unwrap_or_default(), 0o100_644), ("server/sauce-bunny-mcp", launcher.into_bytes(), 0o100_755)])
}

/// Write the Claude Desktop extension to `path` (from a save dialog), atomically.
#[tauri::command]
pub async fn mcp_save_extension(path: String) -> Result<String, AppError> {
    let target = std::path::PathBuf::from(&path);
    if target.extension().is_none_or(|ext| ext != "mcpb") { return Err(AppError::invalid("A Claude Desktop extension is saved as a .mcpb file.")); }
    let bytes = extension(&executable()?);
    let partial = target.with_extension("mcpb.partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, &target)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn the_commands_quote_a_path_with_spaces_and_quotes() {
        let setup = setup_for("/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny");
        assert_eq!(setup.claude_code, "claude mcp add sauce-bunny -- '/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny' --mcp");
        let config: serde_json::Value = serde_json::from_str(&setup.desktop_config).unwrap();
        assert_eq!(config["mcpServers"]["sauce-bunny"]["args"], json!(["--mcp"]));
        assert_eq!(quoted("/Users/o'neil/sb"), "'/Users/o'\\''neil/sb'");
    }

    #[test]
    fn the_extension_is_a_valid_zip_with_a_manifest_and_a_launcher() {
        let dir = std::env::temp_dir().join(format!("sb-mcpb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Sauce Bunny.mcpb");
        std::fs::write(&file, extension("/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny")).unwrap();
        let tested = std::process::Command::new("/usr/bin/unzip").arg("-t").arg(&file).output().unwrap();
        assert!(tested.status.success(), "{}", String::from_utf8_lossy(&tested.stdout));
        let out = dir.join("out");
        assert!(std::process::Command::new("/usr/bin/unzip").arg("-q").arg(&file).arg("-d").arg(&out).status().unwrap().success());
        let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["server"]["entry_point"], "server/sauce-bunny-mcp");
        assert_eq!(manifest["tools"].as_array().unwrap().len(), tools::TOOLS.len());
        let launcher = std::fs::read_to_string(out.join("server/sauce-bunny-mcp")).unwrap();
        assert!(launcher.contains("exec '/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny' --mcp"));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(out.join("server/sauce-bunny-mcp")).unwrap().permissions().mode() & 0o111, 0o111);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
