# Architecture

This document describes the architecture of the Process Stream tool.

## Overview

Process Stream is a real-time command output viewer that runs in the browser. It consists of two main components:

1. **Server** (Bun/TypeScript): Spawns a command, captures stdout/stderr, streams to browser via SSE
2. **Client** (HTML/JavaScript): Receives data via SSE, renders in xterm.js terminals

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌─────────────────┐        ┌─────────────────┐            │
│  │  STDOUT Panel   │        │  STDERR Panel   │            │
│  │  (xterm.js)     │        │  (xterm.js)     │            │
│  └────────┬────────┘        └────────┬────────┘            │
│           │                          │                      │
│           └──────────┬───────────────┘                      │
│                      ▼                                      │
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

Built with Bun.serve, listening on `0.0.0.0:3000` (configurable):

```typescript
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",  // Bind to all interfaces
  fetch(req, server) { ... }
});
```

### Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Main HTML page with embedded JS/CSS |
| `/stdout` | GET | SSE stream for stdout (supports `?from=N` for replay) |
| `/stderr` | GET | SSE stream for stderr (supports `?from=N` for replay) |
| `/combined` | GET | SSE stream for interleaved stdout+stderr (typed events) |
| `/status` | GET | JSON `{running, exitCode}` process status |
| `/kill` | POST | Kill the spawned process |
| `/stdin` | POST | Write text to process stdin |

### SSE (Server-Sent Events)

The server uses SSE to stream data to the browser. A shared `createSSEStream()` helper manages client registration, history replay via `?from=N`, and cleanup:

```typescript
function createSSEStream(
  clients: Set<ReadableStreamDefaultController>,
  replayHistory: (client: ReadableStreamDefaultController) => void
): ReadableStream {
  activeConnectionCount++;
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
      shutdownIfIdle();
    },
  });
}
```

### Data Flow

1. **Process Spawning**
   ```typescript
   const proc = spawn({
     cmd: command,  // From CLI args
     stdout: "pipe",
     stderr: "pipe",
   });
   ```

2. **Streaming stdout** (stderr is identical)
   ```typescript
   proc.stdout.pipeTo(new WritableStream({
     write(chunk) {
       const data = textDecoder.decode(chunk);
       stdoutHistory.push(data);
       broadcastToClients(stdoutClients, data);
       combinedHistory.push({ type: "stdout", data });
       broadcastToClients(combinedClients, data, "stdout");
     },
   }));
   ```

3. **Encoding & Broadcasting**
   Data is base64-encoded to safely transmit ANSI escape sequences, then broadcast to all connected clients:
   ```typescript
   function encodeSSE(data: string, eventType?: string): Uint8Array {
     const base64 = btoa(unescape(encodeURIComponent(data)));
     const eventLine = eventType ? `event: ${eventType}\n` : "";
     return textEncoder.encode(`${eventLine}data: ${base64}\n\n`);
   }

   function broadcastToClients(clients: Set<ReadableStreamDefaultController>, data: string, eventType?: string) {
     const encoded = encodeSSE(data, eventType);
     for (const client of clients) {
       try { client.enqueue(encoded); } catch { clients.delete(client); }
     }
   }
   ```

### Buffering

If a browser connects after the command has already produced output, the server buffers the data:

- `stdoutHistory[]`: Array of buffered stdout chunks
- `stderrHistory[]`: Array of buffered stderr chunks
- `combinedHistory[]`: Array of `{ type, data }` entries for interleaved replay

When a client connects, buffered data is replayed from a given offset (`?from=N`), allowing reconnecting clients to resume without duplicates.

### Lifecycle

1. Server starts, spawns command
2. Client connects via browser
3. Server streams data as it arrives
4. When process exits, "[Process exited with code N]" is sent to all streams
5. Server shuts down after all clients disconnect (5s grace) or 60s with no connections

## Client Architecture

### HTML Structure

```html
<div class="container">
  <div class="panel">
    <div class="panel-header stdout">STDOUT</div>
    <div id="stdout-terminal"></div>
  </div>
  <div class="panel">
    <div class="panel-header stderr">STDERR</div>
    <div id="stderr-terminal"></div>
  </div>
</div>
```

### Terminal Rendering

Uses [xterm.js](https://xtermjs.org/) for full terminal emulation:

```javascript
const stdoutTerm = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Monaco, Menlo, "Courier New", monospace',
  theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
  convertEol: true,  // Handle \n -> \r\n
});

const stdoutFit = new FitAddon.FitAddon();
stdoutTerm.loadAddon(stdoutFit);
stdoutTerm.open(document.getElementById('stdout-terminal'));
```

### SSE Connection

Uses a `connectSSE()` helper with exponential backoff reconnection and offset-based replay:

```javascript
function connectSSE(buildUrl, onConnect) {
  let retryDelay = 1000;
  function connect() {
    const source = new EventSource(buildUrl());
    source.onopen = () => { retryDelay = 1000; };
    onConnect(source);
    source.onerror = () => {
      source.close();
      if (!processExited) {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    };
  }
  connect();
}

let stdoutOffset = 0;
connectSSE(() => '/stdout?from=' + stdoutOffset, source => {
  source.onmessage = e => { stdoutOffset++; writeToTerminal(panels.stdout.terminal, decodeBase64(e.data)); };
});
```

### Search

Uses xterm.js `SearchAddon`. Toggle with 🔍 button or Ctrl+F. Supports find next/previous and Enter/Shift+Enter navigation.

## Key Design Decisions

### 1. Base64 Encoding
ANSI escape sequences contain special characters that can break SSE framing. All data is base64-encoded on server, decoded on client.

### 2. Multi-client Broadcasting
Controllers are stored in `Set<ReadableStreamDefaultController>` sets per stream, allowing multiple browser tabs to view the same process.

### 3. Offset-based Replay
Clients track their position in the server-side history arrays. On reconnect, `?from=N` resumes without duplicate data.

### 4. Binding to 0.0.0.0
Bind to all interfaces so WSL processes are accessible from the Windows host browser.

### 5. ConvertEol
xterm.js `convertEol: true` converts `\n` to `\r\n` since many commands output just `\n`.

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Main server - spawns process, streams output, serves HTML |
| `package.json` | Dependencies (xterm, xterm-addon-fit) |
| `README.md` | Usage instructions |
| `ARCHITECTURE.md` | This file |

## Dependencies

- **Bun**: Server runtime
- **xterm**: Terminal emulator
- **xterm-addon-fit**: Auto-resize terminal to container
- **xterm-addon-search**: Search within terminal buffer

No database or external services required.