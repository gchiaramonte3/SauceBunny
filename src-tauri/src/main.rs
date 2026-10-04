#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--mcp`: serve Sauce Bunny to an assistant over stdio, with no window (src/mcp.rs).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--mcp") { std::process::exit(sauce_bunny_lib::mcp::serve(&args)); }
    sauce_bunny_lib::run();
}
