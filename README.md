# proc-web

Stream any command's output to your browser in real-time — with terminal emulation, stdin support, and signal controls.

## Quick Start

```bash
bun install
bun run server.ts <command> [args...]
```

Then open the URL shown in the terminal.

## Usage

```bash
bun run server.ts npm install
bun run server.ts ping localhost
bun run server.ts tail -f /var/log/syslog
bun run server.ts sh -c 'echo "stdout"; echo "stderr" >&2'
bun run server.ts python3 -i          # interactive REPL via stdin
```

### Options

```
--port N          Listen on port N (default: 3000)
--host ADDR       Bind to address (default: 127.0.0.1)
--token TOKEN     Require token for control actions (kill/stdin/signal)
--pty             Run command in a PTY (enables colour output for TTY-aware programs)
--max-history N   Max chunks to buffer in memory (default: 10000)
--log-dir DIR     Write stdout/stderr/combined logs to a timestamped session dir
```

### Examples

```bash
# Custom port
bun run server.ts --port 8080 <command> [args...]

# Accessible from Windows host when running in WSL
bun run server.ts --host 0.0.0.0 <command> [args...]

# Read-only viewer link + control link
bun run server.ts --token secret123 <command>
# Control:  http://localhost:3000/?token=secret123
# View only: http://localhost:3000/

# PTY mode (colour, interactive programs)
bun run server.ts --pty htop

# Log output to disk
bun run server.ts --log-dir ./logs <command>
```

### WSL / remote access

The server binds to `127.0.0.1` by default. Pass `--host 0.0.0.0` to expose it on all interfaces. The startup message lists all available URLs:

```
Open http://localhost:3000 in your browser
      http://172.20.53.79:3000
```

## Features

| Feature | Description |
|---|---|
| **Live streaming** | stdout and stderr streamed in real-time via SSE |
| **Tabbed view** | STDOUT / STDERR / COMBINED tabs |
| **Combined view** | stdout and stderr interleaved in order; stderr shown in red |
| **Terminal emulation** | Full ANSI escape sequence support via xterm.js |
| **PTY mode** | `--pty` runs the command in a pseudo-terminal for colour/interactive programs |
| **Signal controls** | Send SIGINT / SIGTERM / SIGKILL from the browser, or Ctrl+C / Ctrl+D via raw stdin |
| **Stdin input** | Type input and press Enter; raw bytes (Ctrl+C/D) sent without newline |
| **PTY resize** | Browser terminal dimensions propagated to the PTY on resize/tab switch |
| **Process status** | Live indicator: `● Running` / `● Exited (N)` / `● Spawn Error` |
| **Token auth** | `--token` splits viewer (read-only) and controller (kill/stdin) access |
| **Auto-scroll toggle** | Pause/resume scroll without losing buffered output |
| **Search** | Ctrl+F or Search button; find next/previous with Enter / Shift+Enter |
| **Download output** | Save the current tab's terminal buffer as a `.txt` file |
| **Disk logging** | `--log-dir` writes per-session stdout/stderr/combined logs + metadata.json |
| **Bounded history** | `--max-history` caps in-memory buffer to prevent unbounded growth |
| **Multi-client** | Multiple browser tabs all receive output independently |
| **Reconnect** | SSE reconnects with exponential backoff; resumes from last position via `Last-Event-ID` |
| **Buffering** | Late-connecting clients receive full output history |
| **Auto-shutdown** | Server stops 5 s after all clients disconnect post-exit |
| **UTF-8 streaming** | Correct handling of multibyte characters across chunk boundaries |
| **SSE heartbeats** | Periodic keepalive pings prevent idle connection drops |

## Troubleshooting

**Port already in use**

```bash
fuser -k 3000/tcp
# or use a different port:
bun run server.ts --port 4000 <command>
```

**Can't connect from Windows (WSL)**

Start with `--host 0.0.0.0` and use the WSL IP shown in the startup output:

```bash
hostname -I | awk '{print $1}'
```

**Program shows no colour / behaves differently than in terminal**

Use `--pty` to run the command inside a pseudo-terminal.

## License

MIT
