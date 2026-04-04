# Architecture

This document describes the architecture of proc-web.

## Overview

proc-web is a real-time command output viewer that runs in the browser. It supports multiple concurrent sessions with persistent history. It consists of two main components:

1. **Server** (Bun/TypeScript): Spawns commands, captures stdout/stderr, streams to browser via SSE
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
│                     ▼              Server                   │
│            ┌──────────────────┐                             │
│            │   Bun.serve      │                             │
│            │   (HTTP Server)  │                             │
│            └────────┬─────────┘                             │
│                     │                                        │
│            ┌────────┴─────────┐                             │
│            │  SessionManager  │                             │
│            └────────┬─────────┘                             │
│     ┌──────────────┼──────────────┐                         │
│     ▼              ▼              ▼                         │
│  ┌────────┐  ┌──────────┐  ┌──────────┐                    │
│  │Session │  │ Session  │  │ Session  │                    │
│  │  #1    │  │   #2     │  │   #3     │                    │
│  └───┬────┘  └────┬─────┘  └────┬─────┘                    │
│      │            │             │                            │
│  ┌───┴────┐       │             │                            │
│  │/stdout │       │             │                            │
│  │/stderr │  (SSE │             │                            │
│  │/combined│ streams per        │                            │
│  │/status │  session)           │                            │
│  └───┬────┘       │             │                            │
│      │            │             │                            │
└──────┼────────────┼─────────────┼───────────────────────────┘
       ▼            ▼             ▼
  ┌────────┐   ┌────────┐   ┌────────┐
  │ Process│   │ Process│   │ Process│
  └────────┘   └────────┘   └────────┘
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

#### Session-scoped routes (prefix: `/sessions/:sessionId`)

| Route | Method | Auth required | Description |
|-------|--------|---------------|-------------|
| `/sessions/:id` | GET | — | Session view HTML (active or completed) |
| `/sessions/:id/stdout` | GET | — | SSE stream for stdout (supports `?from=N` / `Last-Event-ID` for replay) |
| `/sessions/:id/stderr` | GET | — | SSE stream for stderr (supports `?from=N` / `Last-Event-ID` for replay) |
| `/sessions/:id/combined` | GET | — | SSE stream for interleaved stdout+stderr (typed events) |
| `/sessions/:id/status` | GET | — | JSON `{running, exitCode, spawnError}` process status |
| `/sessions/:id/kill` | POST | yes | Kill the spawned process |
| `/sessions/:id/stdin` | POST | yes | Write text to process stdin; `?raw=1` omits the trailing newline |
| `/sessions/:id/signal` | POST | yes | Send a named signal (`SIGINT`, `SIGTERM`, `SIGKILL`) to the process |
| `/sessions/:id/resize` | POST | yes | Resize the PTY (PTY mode only); body `{cols, rows}` |
| `/sessions/:id/rerun` | POST | yes | Create a new session with the same command |
| `/sessions/:id/export/stdout` | GET | — | Download stdout log |
| `/sessions/:id/export/stderr` | GET | — | Download stderr log |
| `/sessions/:id/export/combined` | GET | — | Download combined log |
| `/sessions/:id/export/metadata` | GET | — | Download session metadata as JSON |

#### Top-level routes

| Route | Method | Auth required | Description |
|-------|--------|---------------|-------------|
| `/` or `/index.html` | GET | — | Session list HTML page with embedded JS/CSS |
| `/api/sessions` | GET | — | JSON array of all session metadata (active + completed) |
| `/api/sessions` | POST | yes | Create a new session; body `{ command: string[] }` |

### Authentication

An optional token (`--token TOKEN`) enables split viewer/controller access:

- **No token set**: all routes are accessible to anyone.
- **Token set**: SSE/status/export/list routes are public (read-only). POST endpoints (`/kill`, `/stdin`, `/signal`, `/resize`, `/rerun`, session creation) require the token, supplied as `Authorization: Bearer <token>` or `?token=<token>`.
- Each HTML page receives a `HAS_CONTROL` flag (server-side computed from the request) that hides control elements when the requester is unauthenticated.

### Session Management

Two classes manage session lifecycle:

**`Session`** (`server.ts:85-476`): Represents a single process run. Responsibilities:
- Spawns the process (pipe or PTY mode) in the constructor
- Maintains per-stream in-memory history with bounded retention
- Manages SSE client sets (`stdoutClients`, `stderrClients`, `combinedClients`)
- Handles process output decoding, broadcasting, and disk logging
- Provides `createSSEStream()` for streaming with history replay
- Tracks process exit and updates metadata on disk

**`SessionManager`** (`server.ts:480-562`): Manages all sessions. Responsibilities:
- Creates new sessions and tracks them in `sessions: Map<string, Session>`
- Moves completed session metadata to `completedMeta: Map<string, SessionMetadata>`
- Loads completed session metadata from disk on startup (`loadCompletedSessions()`)
- Provides lookup by ID for both active and completed sessions

#### Session Metadata

```typescript
interface SessionMetadata {
  id: string;
  command: string[];
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  exitCode: number | null;
  spawnError: string | null;
  processExited: boolean;
  pty: boolean;
}
```

### SSE (Server-Sent Events)

Each `Session` instance provides `createSSEStream()` which manages client registration, history replay, and cleanup:

```typescript
createSSEStream(
  clients: Set<ReadableStreamDefaultController>,
  replayHistory: (client: ReadableStreamDefaultController) => void
): ReadableStream
```

On connection the client is added to the set, history is replayed from the requested offset, and a heartbeat timer is started if this is the first client. On cancel the client is removed and the heartbeat stops if no clients remain.

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
   encodeSSE(data: string, eventType?: string, id?: number): Uint8Array {
     const base64 = btoa(unescape(encodeURIComponent(data)));
     const idLine = id !== undefined ? `id: ${id}\n` : "";
     const eventLine = eventType ? `event: ${eventType}\n` : "";
     return textEncoder.encode(`${idLine}${eventLine}data: ${base64}\n\n`);
   }
   ```

### Buffering & Bounded History

Each session stream keeps a rolling in-memory history:

- `stdoutHistory[]` / `stderrHistory[]` / `combinedHistory[]`
- Capped at `MAX_HISTORY` chunks (default 10 000, configurable with `--max-history`).
- A per-stream `dropped` counter tracks how many chunks were evicted, keeping `?from=N` offsets globally valid even after trimming.

When a client connects, buffered data is replayed from the requested offset so late-connecting clients receive full (or partial, if trimmed) output history.

### SSE Heartbeats

Idle SSE connections are kept alive with periodic heartbeat comments (`: ping\n\n`) every 15 seconds. Heartbeats start when the first client connects to a session and stop when the last one disconnects.

### UTF-8 Streaming Decode

Each session stream uses a dedicated `TextDecoder` with `{ stream: true }` to correctly handle multibyte UTF-8 characters spanning chunk boundaries. Decoders are flushed on stream close.

### Disk Logging (`--log-dir`)

When `--log-dir DIR` is given, a UUID-based session directory is created under `DIR`:

```
DIR/
  <session-uuid>/
    stdout.log
    stderr.log
    combined.log
    metadata.json   ← command, PID, start/end time, exit code
```

Chunks are appended synchronously via `appendFileSync` as they arrive. `metadata.json` is written at session start and updated on process exit. Completed session metadata is loaded from disk on server startup, making sessions persist across restarts.

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

1. Server starts, loads completed session metadata from disk (if `--log-dir` is set).
2. The CLI command is spawned as the initial session.
3. Clients connect via browser — the session list page or a specific session view.
4. Server streams data as it arrives; late clients replay from history.
5. When process exits, `[Process exited with code N]` is sent to all streams.
6. Completed session metadata is stored in memory and on disk.
7. `SIGINT`/`SIGTERM` to the server kills all child processes and stops the HTTP server cleanly.

## Client Architecture

The client consists of three server-rendered HTML pages with inline JavaScript:

### Pages

1. **Session list** (`/`): Shows all sessions in a table with ID, command, status, start time, duration, and a rerun button. Auto-refreshes every 2 seconds. Includes a "new session" input when authenticated.

2. **Active session view** (`/sessions/:id`): Full terminal viewer with tabs (STDOUT/STDERR/COMBINED), stdin input, signal controls, search, scroll pause, and download.

3. **Completed session view** (`/sessions/:id`): Read-only details page with session metadata, download links for logs, and a rerun button.

### Active Session HTML Structure

```html
<header>            <!-- logo, session ID, command, status indicator, kill button -->
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

Uses a `connectSSE()` helper with exponential backoff reconnection. Offset-based replay is used for reconnect:

```javascript
let stdoutLastId = -1;
connectSSE(() => '/sessions/' + SESSION_ID + '/stdout' + (stdoutLastId >= 0 ? '?from=' + (stdoutLastId + 1) : ''), source => {
  source.onmessage = e => {
    if (e.lastEventId) stdoutLastId = parseInt(e.lastEventId);
    writeToTerminal(panels.stdout.terminal, decodeBase64(e.data));
  };
});
```

The combined stream uses typed events (`stdout`, `stderr`) with stderr rendered in red.

### Viewer / Controller Permissions

The `HAS_CONTROL` flag (injected server-side based on token auth) hides the kill button and stdin area for unauthenticated viewers. All mutating fetch calls include an `Authorization: Bearer` header when a token is present.

### PTY Resize

On tab switch and window resize the active terminal is fitted, then its dimensions are posted to `/sessions/:id/resize` so the server-side PTY tracks the browser window size.

### Search

Uses `SearchAddon`. Toggle with the Search button or Ctrl+F. Supports find next/previous via buttons or Enter/Shift+Enter.

### Signal Controls

The stdin bar exposes:
- **Send**: POST to `/sessions/:id/stdin` with the input text.
- **Ctrl+C / Ctrl+D**: POST raw bytes (`\x03` / `\x04`) to `/sessions/:id/stdin?raw=1`.
- **INT / TERM / KILL**: POST `{ signal: "SIGINT" | "SIGTERM" | "SIGKILL" }` to `/sessions/:id/signal`.

## Key Design Decisions

### 1. Base64 Encoding
ANSI escape sequences contain special characters that break SSE framing. All data is base64-encoded on the server and decoded on the client.

### 2. SSE `id:` for Replay
Every message carries a monotonically increasing `id:` equal to its global chunk offset. The browser automatically sends `Last-Event-ID` on reconnect, enabling zero-duplicate replay without custom state.

### 3. Bounded History
History arrays are capped (`--max-history`) with a `dropped` counter so `?from=N` offsets stay valid after trimming. Prevents unbounded memory growth for long-running processes.

### 4. Multi-client Broadcasting
Controllers are stored in `Set<ReadableStreamDefaultController>` per stream per session, allowing multiple browser tabs to view the same process simultaneously.

### 5. Host Binding
Default host is `127.0.0.1` (localhost only). Pass `--host 0.0.0.0` to bind to all interfaces for WSL / remote access.

### 6. ConvertEol
xterm.js `convertEol: true` converts `\n` to `\r\n` since many commands output bare `\n`.

### 7. PTY vs Pipe Mode
Pipe mode captures separate stdout/stderr streams. PTY mode merges them but gives the process a real TTY, enabling colour output and interactive programs that detect pipe mode and disable features.

### 8. UUID-based Session Directories
Session log directories use UUIDs (not timestamps) for uniqueness and to avoid filesystem ordering assumptions.

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Main server — session management, process spawning, SSE streaming, HTML generation |
| `sessions.test.ts` | Integration tests for session CRUD, exports, reruns, and persistence |
| `package.json` | Dependencies (node-pty, xterm, xterm-addon-fit) |
| `README.md` | Usage instructions |
| `ARCHITECTURE.md` | This file |
| `PLAN.md` | Implementation roadmap |
| `AGENTS.md` | Guidelines for AI agents working on the codebase |

## Dependencies

- **Bun**: Server runtime
- **xterm**: Terminal emulator (loaded from CDN)
- **xterm-addon-fit**: Auto-resize terminal to container (loaded from CDN)
- **xterm-addon-search**: Search within terminal buffer (loaded from CDN)
- **node-pty**: PTY support (optional, required only with `--pty`)

No database or external services required.
