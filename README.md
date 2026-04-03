# proc-web

Stream any command's output to your browser in real-time — with terminal emulation, stdin support, and a kill button.

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

### Custom port

```bash
bun run server.ts --port 8080 <command> [args...]
```

### WSL / remote access

The server binds to `0.0.0.0`. When running on WSL, the startup message shows both URLs:

```
Open http://localhost:3000 in your browser
Open http://172.20.53.79:3000 in your Windows browser
```

## Features

| Feature | Description |
|---|---|
| **Live streaming** | stdout and stderr streamed in real-time via SSE |
| **Tabbed view** | STDOUT / STDERR / COMBINED tabs |
| **Combined view** | stdout and stderr interleaved in order; stderr shown in red |
| **Terminal emulation** | Full ANSI escape sequence support via xterm.js |
| **Kill button** | Send SIGTERM to the process from the browser |
| **Stdin input** | Type input at the bottom bar and press Enter (or click Send) |
| **Process status** | Live indicator shows `● Running` / `● Exited (N)` |
| **Auto-scroll toggle** | Pause/resume scroll without losing buffered output |
| **Download output** | Save the current tab's terminal buffer as a `.txt` file |
| **Multi-client** | Multiple browser tabs all receive output independently |
| **Reconnect** | SSE reconnects with exponential backoff; resumes from last position |
| **Buffering** | Late-connecting clients receive full output history |
| **Configurable port** | `--port N` flag |
| **Auto-shutdown** | Server stops 5s after all clients disconnect post-exit |

## Troubleshooting

**Port already in use**

```bash
fuser -k 3000/tcp
# or use a different port:
bun run server.ts --port 4000 <command>
```

**Can't connect from Windows (WSL)**

Use the WSL IP shown in the startup output, not `localhost`:

```bash
hostname -I | awk '{print $1}'
```

## License

MIT
