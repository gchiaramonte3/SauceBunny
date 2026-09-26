Generated Apple Silicon worker lives here after `npm run build:video`.
Do not commit the frozen runtime or any model weights.
The folder-mode executable avoids an unpacking child process: Stop owns the
actual decoder/model process, including during cold startup.
