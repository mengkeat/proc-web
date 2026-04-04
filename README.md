# proc-web

Stream any command's output to your browser in real-time — with terminal emulation, stdin support, signal controls, and multi-session management.

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
--log-dir DIR     Write stdout/stderr/combined logs to a session dir
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

# Log output to disk (enables session persistence)
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
| **Multi-session** | Create multiple sessions; browse them on the home page |
| **Session list** | Home page shows all sessions with ID, command, status, start time, duration, exit code |
| **Session pages** | Each session has a dedicated URL (`/sessions/:id`) for sharing |
| **Rerun** | Re-run any completed session with one click |
| **Log export** | Download full stdout, stderr, combined logs, and metadata for any session |
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
| **Session persistence** | `--log-dir` enables session metadata to survive server restarts; completed sessions are browsable |
| **Bounded history** | `--max-history` caps in-memory buffer to prevent unbounded growth |
| **Multi-client** | Multiple browser tabs all receive output independently |
| **Reconnect** | SSE reconnects with exponential backoff; resumes from last position via `Last-Event-ID` |
| **Buffering** | Late-connecting clients receive full output history |
| **Auto-shutdown** | Server stops 5 s after all clients disconnect post-exit |
| **UTF-8 streaming** | Correct handling of multibyte characters across chunk boundaries |
| **SSE heartbeats** | Periodic keepalive pings prevent idle connection drops |

## API Reference

### Session Management

| Route | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | — | Session list / home page |
| `/api/sessions` | GET | — | List all sessions as JSON |
| `/api/sessions` | POST | yes | Create a new session: `{"command": ["cmd", "args"]}` |
| `/sessions/:id` | GET | — | View a specific session (live terminal or completed details) |
| `/sessions/:id/status` | GET | — | Session status JSON: `{running, exitCode, spawnError}` |
| `/sessions/:id/kill` | POST | yes | Kill a running session |
| `/sessions/:id/stdin` | POST | yes | Write to session stdin; `?raw=1` for raw bytes |
| `/sessions/:id/signal` | POST | yes | Send signal: `{signal: "SIGINT"}` |
| `/sessions/:id/resize` | POST | yes | Resize PTY: `{cols, rows}` |
| `/sessions/:id/rerun` | POST | yes | Create a new session with the same command |
| `/sessions/:id/export/stdout` | GET | — | Download full stdout log |
| `/sessions/:id/export/stderr` | GET | — | Download full stderr log |
| `/sessions/:id/export/combined` | GET | — | Download combined log |
| `/sessions/:id/export/metadata` | GET | — | Download session metadata as JSON |

### Session SSE Streams

| Route | Method | Description |
|---|---|---|
| `/sessions/:id/stdout` | GET | SSE stream for stdout |
| `/sessions/:id/stderr` | GET | SSE stream for stderr |
| `/sessions/:id/combined` | GET | SSE stream for interleaved stdout+stderr |

All SSE streams support `?from=N` and `Last-Event-ID` for replay on reconnect.

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
