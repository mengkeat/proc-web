# Architecture

This document describes the architecture of the Process Stream tool.

## Overview

Process Stream is a real-time command output viewer that runs in the browser. It consists of two main components:

1. **Server** (Bun/TypeScript): Spawns a command, captures stdout/stderr, streams to browser via SSE
2. **Client** (HTML/JavaScript): Receives data via SSE, renders in xterm.js terminals

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  STDOUT  │  │  STDERR  │  │ COMBINED │  (tabs)          │
│  │ (xterm)  │  │ (xterm)  │  │ (xterm)  │                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       └─────────────┼─────────────┘                         │
│                     ▼                                        │
│            ┌──────────────────┐                             │
│            │   EventSource    │                             │
│            │   (SSE Client)   │                             │
│            └────────┬─────────┘                             │
└─────────────────────┼───────────────────────────────────────┘
                      │ HTTP/SSE
┌─────────────────────┼───────────────────────────────────────┐
│                     ▼              WSL/Server               │
│            ┌──────────────────┐                             │
│            │   Bun.serve      │                             │
│            │   (HTTP Server)  │                             │
│            └────────┬─────────┘                             │
│                     │                                        │
│     ┌───────────────┼───────────────┐                       │
│     ▼               ▼               ▼                       │
│  ┌──────┐      ┌─────────┐    ┌─────────┐                   │
│  │HTML  │      │ /stdout │    │ /stderr │                   │
│  │Page  │      │  SSE    │    │  SSE    │                   │
│  └──────┘      └────┬────┘    └────┬────┘                   │
│                     │               │                        │
└─────────────────────┼───────────────┼────────────────────────┘
                      │               │
                      ▼               ▼
               ┌────────────────────────────────────────┐
               │         Spawned Process                │
               │  ┌──────────┐    ┌──────────┐          │
               │  │  stdout  │    │  stderr  │          │
               │  │  (pipe)  │    │  (pipe)  │          │
               │  └────┬─────┘    └────┬─────┘          │
               └───────┼───────────────┼─────────────────┘
                       │               │
                       ▼               ▼
                  Process Output Streams
```

## Server Architecture

### HTTP Server

Built with Bun.serve, listening on a configurable host/port (default `127.0.0.1:3000`):

```typescript
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) { ... }
});
```

### Routes

| Route | Method | Auth required | Description |
|-------|--------|---------------|-------------|
| `/` | GET | — | Main HTML page with embedded JS/CSS |
| `/stdout` | GET | — | SSE stream for stdout (supports `?from=N` / `Last-Event-ID` for replay) |
| `/stderr` | GET | — | SSE stream for stderr (supports `?from=N` / `Last-Event-ID` for replay) |
| `/combined` | GET | — | SSE stream for interleaved stdout+stderr (typed events) |
| `/status` | GET | — | JSON `{running, exitCode, spawnError}` process status |
| `/kill` | POST | yes | Kill the spawned process (SIGTERM) |
| `/stdin` | POST | yes | Write text to process stdin; `?raw=1` omits the trailing newline |
| `/signal` | POST | yes | Send a named signal (`SIGINT`, `SIGTERM`, `SIGKILL`) to the process |
| `/resize` | POST | yes | Resize the PTY (PTY mode only); body `{cols, rows}` |

### Authentication

An optional token (`--token TOKEN`) enables split viewer/controller access:

- **No token set**: all routes are accessible to anyone.
- **Token set**: SSE/status routes are public (read-only). `/kill`, `/stdin`, `/signal`, `/resize` require the token, supplied as `Authorization: Bearer <token>` or `?token=<token>`.
- The HTML page receives a `HAS_CONTROL` flag that hides the kill button and stdin area when the requester is unauthenticated.

### SSE (Server-Sent Events)

The server uses SSE to stream data to the browser. A shared `createSSEStream()` helper manages client registration, history replay, and cleanup:

```typescript
function createSSEStream(
  clients: Set<ReadableStreamDefaultController>,
  replayHistory: (client: ReadableStreamDefaultController) => void
): ReadableStream {
  activeConnectionCount++;
  if (activeConnectionCount === 1) startHeartbeat();
  let thisClient!: ReadableStreamDefaultController;
  return new ReadableStream({
    start(controller) {
      thisClient = controller;
      clients.add(controller);
      replayHistory(controller);
    },
    cancel() {
      activeConnectionCount--;
      clients.delete(thisClient);
      if (activeConnectionCount === 0) stopHeartbeat();
      shutdownIfIdle();
    },
  });
}
```

Each SSE message carries an `id:` field (the global chunk offset) so that the browser's native `Last-Event-ID` reconnect mechanism replays only missed chunks.

### Data Flow

1. **Process Spawning** — pipe mode (default)
   ```typescript
   proc = spawn({ cmd: command, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
   ```
   PTY mode (`--pty`):
   ```typescript
   ptyProc = nodePty.spawn(command[0], command.slice(1), {
     name: "xterm-256color", cols: 80, rows: 24, ...
   });
   ```

2. **Streaming stdout** (stderr identical in pipe mode; PTY has a single output stream)
   ```typescript
   proc.stdout.pipeTo(new WritableStream({
     write(chunk) {
       const data = stdoutDecoder.decode(chunk, { stream: true });
       handleStdoutData(data);  // history + broadcast + log
     },
     close() {
       const remaining = stdoutDecoder.decode();
       if (remaining) handleStdoutData(remaining);
     },
   }));
   ```

3. **Encoding & Broadcasting**
   Data is base64-encoded to safely transmit ANSI escape sequences, then broadcast to all connected clients:
   ```typescript
   function encodeSSE(data: string, eventType?: string, id?: number): Uint8Array {
     const base64 = btoa(unescape(encodeURIComponent(data)));
     const idLine = id !== undefined ? `id: ${id}\n` : "";
     const eventLine = eventType ? `event: ${eventType}\n` : "";
     return textEncoder.encode(`${idLine}${eventLine}data: ${base64}\n\n`);
   }
   ```

### Buffering & Bounded History

Each stream keeps a rolling in-memory history:

- `stdoutHistory[]` / `stderrHistory[]` / `combinedHistory[]`
- Capped at `MAX_HISTORY` chunks (default 10 000, configurable with `--max-history`).
- A per-stream `dropped` counter tracks how many chunks were evicted, keeping `?from=N` offsets globally valid even after trimming.

When a client connects, buffered data is replayed from the requested offset so late-connecting clients receive full (or partial, if trimmed) output history.

### SSE Heartbeats

Idle SSE connections are kept alive with periodic heartbeat comments (`: ping\n\n`) every 15 seconds. Heartbeats start when the first client connects and stop when the last one disconnects.

### UTF-8 Streaming Decode

Each stream uses a dedicated `TextDecoder` with `{ stream: true }` to correctly handle multibyte UTF-8 characters spanning chunk boundaries. Decoders are flushed on stream close.

### Disk Logging (`--log-dir`)

When `--log-dir DIR` is given, a timestamped session directory is created under `DIR`:

```
DIR/
  2025-01-15T12-34-56-789Z/
    stdout.log
    stderr.log
    combined.log
    metadata.json   ← command, PID, start/end time, exit code
```

Chunks are appended synchronously via `appendFileSync` as they arrive. `metadata.json` is written at start and updated on process exit.

### PTY Mode (`--pty`)

When `--pty` is passed the command is run inside a pseudo-terminal via `node-pty`:

- The process sees a real TTY, so programs that disable colour/interactive features in pipe mode behave normally.
- stdout and stderr are merged into a single PTY output stream; both are written to `stdoutHistory` and broadcast on `/stdout` and `/combined`.
- `/resize` resizes the PTY to match the browser terminal dimensions.
- Raw stdin (`?raw=1`) passes bytes directly without appending a newline.

### Error Handling

- **Spawn failures**: Caught at startup; error message broadcast to all SSE streams; exit code 127.
- **Pipe errors**: `.catch()` on `pipeTo()` logs without crashing.
- **Process exit errors**: `.catch()` on `proc.exited` broadcasts a failure message.
- **Client status**: `/status` includes `spawnError` for UI display.

### Lifecycle

1. Server starts, spawns command.
2. Client connects via browser.
3. Server streams data as it arrives; late clients replay from history.
4. When process exits, `[Process exited with code N]` is sent to all streams.
5. Server shuts down 5 s after all clients disconnect post-exit, or after 60 s with no connections at all.
6. `SIGINT`/`SIGTERM` to the server kills the child and stops the HTTP server cleanly.

## Client Architecture

### HTML Structure

```html
<header>            <!-- logo, command, status indicator, kill button -->
<div class="tabs-bar">
  STDOUT | STDERR | COMBINED      <!-- tab switcher -->
  Search | Pause | Save           <!-- per-tab actions -->
</div>
<div id="search-bar">...</div>    <!-- collapsible search bar -->
<div class="panels">
  <div id="panel-stdout">  <div id="stdout-terminal">  </div>
  <div id="panel-stderr">  <div id="stderr-terminal">  </div>
  <div id="panel-combined"><div id="combined-terminal"></div>
</div>
<div id="stdin-area">
  stdin input | Send | Ctrl+C | Ctrl+D | INT | TERM | KILL
</div>
```

### Terminal Rendering

Uses [xterm.js](https://xtermjs.org/) for full terminal emulation. Three independent terminal instances are created (stdout, stderr, combined); stderr uses a red foreground theme:

```javascript
const panels = {
  stdout:   createPanel('stdout-terminal'),
  stderr:   createPanel('stderr-terminal', { ...TERMINAL_OPTIONS, theme: { foreground: '#f14c4c' } }),
  combined: createPanel('combined-terminal'),
};
```

Each panel has `FitAddon` (auto-resize) and `SearchAddon` loaded.

### SSE Connection

Uses a `connectSSE()` helper with exponential backoff reconnection. The browser's native `Last-Event-ID` header (set automatically from the SSE `id:` field) is used for offset-based replay on reconnect:

```javascript
let stdoutOffset = 0;
connectSSE(() => '/stdout?from=' + stdoutOffset, source => {
  source.onmessage = e => {
    stdoutOffset++;
    writeToTerminal(panels.stdout.terminal, decodeBase64(e.data));
  };
});
```

### Viewer / Controller Permissions

The `HAS_CONTROL` flag (injected server-side based on token auth) hides the kill button and stdin area for unauthenticated viewers. All mutating fetch calls include an `Authorization: Bearer` header when a token is present.

### PTY Resize

On tab switch and window resize the active terminal is fitted, then its dimensions are posted to `/resize` so the server-side PTY tracks the browser window size.

### Search

Uses `SearchAddon`. Toggle with the Search button or Ctrl+F. Supports find next/previous via buttons or Enter/Shift+Enter.

### Signal Controls

The stdin bar exposes:
- **Send**: POST to `/stdin` with the input text.
- **Ctrl+C / Ctrl+D**: POST raw bytes (`\x03` / `\x04`) to `/stdin?raw=1`.
- **INT / TERM / KILL**: POST `{ signal: "SIGINT" | "SIGTERM" | "SIGKILL" }` to `/signal`.

## Key Design Decisions

### 1. Base64 Encoding
ANSI escape sequences contain special characters that break SSE framing. All data is base64-encoded on the server and decoded on the client.

### 2. SSE `id:` for Replay
Every message carries a monotonically increasing `id:` equal to its global chunk offset. The browser automatically sends `Last-Event-ID` on reconnect, enabling zero-duplicate replay without custom state.

### 3. Bounded History
History arrays are capped (`--max-history`) with a `dropped` counter so `?from=N` offsets stay valid after trimming. Prevents unbounded memory growth for long-running processes.

### 4. Multi-client Broadcasting
Controllers are stored in `Set<ReadableStreamDefaultController>` per stream, allowing multiple browser tabs to view the same process simultaneously.

### 5. Host Binding
Default host is `127.0.0.1` (localhost only). Pass `--host 0.0.0.0` to bind to all interfaces for WSL / remote access.

### 6. ConvertEol
xterm.js `convertEol: true` converts `\n` to `\r\n` since many commands output bare `\n`.

### 7. PTY vs Pipe Mode
Pipe mode captures separate stdout/stderr streams. PTY mode merges them but gives the process a real TTY, enabling colour output and interactive programs that detect pipe mode and disable features.

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Main server — spawns process, streams output, serves HTML |
| `package.json` | Dependencies (xterm, xterm-addon-fit, node-pty) |
| `README.md` | Usage instructions |
| `ARCHITECTURE.md` | This file |

## Dependencies

- **Bun**: Server runtime
- **xterm**: Terminal emulator
- **xterm-addon-fit**: Auto-resize terminal to container
- **xterm-addon-search**: Search within terminal buffer
- **node-pty**: PTY support (optional, required only with `--pty`)

No database or external services required.
