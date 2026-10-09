#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--mcp`: serve Sauce Bunny to an assistant over stdio, with no window (src/mcp.rs).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--mcp") { std::process::exit(sauce_bunny_lib::mcp::serve(&args)); }
    // `--eval` / `--eval-template`: the transcript accuracy scorer (src/eval.rs), a developer tool with no window.
    if args.iter().any(|arg| arg == "--eval" || arg == "--eval-template" || arg == "--eval-bleed" || arg == "--eval-ownership") { std::process::exit(sauce_bunny_lib::eval::run(&args)); }
    // `--probe-media`: check linked media for the app from a child process, so a
    // network volume that stops answering holds the child, never the app.
    if args.iter().any(|arg| arg == "--probe-media") { std::process::exit(sauce_bunny_lib::probe_media()); }
    sauce_bunny_lib::run();
}
