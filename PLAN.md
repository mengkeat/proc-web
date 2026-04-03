# proc-web: Improvement & Feature Ideas

## Critical Bug

### Multi-client support
**Current**: `stdoutController` and `stderrController` are single references. Opening a second browser tab overwrites the first controller — the first tab silently stops receiving data.

**Fix**: Replace single controller references with a `Set<ReadableStreamDefaultController>` and broadcast to all active clients.

---

## Feature Ideas (ranked by value)

### 1. Kill Process Button (High Value)
Add a `/kill` POST endpoint on the server. In the UI, show a "Kill" button in the header that sends a POST to `/kill`, which calls `proc.kill()`. Invaluable for long-running commands.

### 2. Stdin Input (High Value)
Add a text input field in the UI and a `/stdin` POST endpoint. The server writes the POSTed data to `proc.stdin`. Makes the tool usable with interactive processes (e.g., python REPL, node).

### 3. Combined / Interleaved View (Medium-High Value)
Add a third "Combined" panel (or toggle mode) that shows stdout and stderr interleaved in chronological order, color-coded (teal for stdout, red for stderr). Requires timestamping chunks on the server and merging on the client.

### 4. Process Status in Header (Medium Value)
- Show a live indicator: Running / Exited (code N)
- Add a `/status` SSE or polling endpoint that emits the exit code
- Display exit code in the header once process completes

### 5. Auto-scroll Toggle (Medium Value)
Add a "Pause scroll" toggle button. When paused, new data still arrives but the terminal doesn't auto-scroll, letting the user review earlier output.

### 6. Download Output (Medium Value)
"Save" buttons for stdout and stderr that extract the terminal buffer text and download as a `.txt` file. Can use `term.buffer.active` to read lines.

### 7. Search (Medium Value)
Load xterm's `SearchAddon` (already a separate package). Add Ctrl+F or a search bar that calls `searchAddon.findNext(query)`.

### 8. Configurable Port via CLI flag (Low-Medium Value)
Support `--port <N>` CLI flag. Parse `Bun.argv` for `--port` before the command starts. Useful when port 3000 is occupied.

### 9. Auto-reconnect on Disconnect (Low-Medium Value)
In the browser JS, if an SSE `onerror` fires while the process is still running, implement exponential backoff reconnection instead of just showing "[Stream disconnected]".

### 10. Timestamps Toggle (Low Value)
Optionally prefix each line with a relative or absolute timestamp. Requires server-side tagging with a timestamp field in the SSE event.

---

## Architecture Notes

- Critical files: `server.ts` (only source file)
- No build step needed — Bun runs TypeScript directly
- All HTML/CSS/JS is embedded as a template literal in `server.ts`

---

## Recommended Priority Order

1. Fix multi-client bug (correctness)
2. Process kill button (most useful feature)
3. Process status / exit code in header (quick win)
4. Combined view (high user value)
5. Stdin support (transforms tool capability)
6. Auto-scroll toggle + download (UX polish)
7. Configurable port (DX improvement)
