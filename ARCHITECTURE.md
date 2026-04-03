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

| Route | Description |
|-------|-------------|
| `/` | Main HTML page with embedded JS/CSS |
| `/stdout` | SSE stream for stdout |
| `/stderr` | SSE stream for stderr |

### SSE (Server-Sent Events)

The server uses SSE to stream data to the browser:

```typescript
// Each client gets its own ReadableStream controller
const stream = new ReadableStream({
  start(controller) {
    // Store controller for later use
    stdoutController = controller;
  },
});

return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  },
});
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

2. **Streaming stdout**
   ```typescript
   proc.stdout.pipeTo(new WritableStream({
     write(chunk) {
       const data = new TextDecoder().decode(chunk);
       if (stdoutController) {
         sendEvent(stdoutController, data);
       } else {
         stdoutBuffer.push(data);  // Buffer for late clients
       }
     },
   }));
   ```

3. **Encoding**
   Data is base64-encoded to safely transmit ANSI escape sequences:
   ```typescript
   function sendEvent(controller, data) {
     const encoded = btoa(unescape(encodeURIComponent(data)));
     controller.enqueue(`data: ${encoded}\n\n`);
   }
   ```

### Buffering

If a browser connects after the command has already produced output, the server buffers the data:

- `stdoutBuffer[]`: Array of buffered stdout chunks
- `stderrBuffer[]`: Array of buffered stderr chunks

When a client connects, buffered data is sent immediately.

### Lifecycle

1. Server starts, spawns command
2. Client connects via browser
3. Server streams data as it arrives
4. When process exits, "[Process completed]" is sent
5. Server shuts down after all clients disconnect (or 60s timeout)

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

```javascript
const stdoutEventSource = new EventSource('/stdout');

stdoutEventSource.onmessage = (event) => {
  // Decode base64 back to string
  const decoded = decodeURIComponent(escape(atob(event.data)));
  stdoutTerm.write(decoded);  // Write to terminal
};
```

## Key Design Decisions

### 1. Base64 Encoding

Why: ANSI escape sequences contain special characters that can break JSON or be misinterpreted.

Solution: Encode as base64 on server, decode on client.

### 2. TextDecoder for Binary Data

Why: `chunk.toString()` on Uint8Array returns comma-separated numbers, not text.

Solution: Use `new TextDecoder().decode(chunk)`.

### 3. Global Controllers

Why: SSE streams need to persist across requests.

Solution: Store controllers in module-level variables (`stdoutController`, `stderrController`).

### 4. Binding to 0.0.0.0

Why: `localhost` only accepts connections from the same machine.

Solution: Bind to `0.0.0.0` to accept connections from Windows in WSL.

### 5. ConvertEol Option

Why: Terminals expect `\r\n` but many commands output just `\n`.

Solution: xterm.js `convertEol: true` handles the conversion.

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

No database or external services required.