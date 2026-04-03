# proc-web: Improvement & Feature Ideas

## ✅ Completed Features

### Multi-client support
**Status**: ✅ Implemented  
Controllers are stored in `Set<ReadableStreamDefaultController>` sets (`stdoutCtls`, `stderrCtls`, `combinedCtls`) and broadcast to all active clients. New clients receive buffered replay on connect.

### Kill Process Button
**Status**: ✅ Implemented  
`/kill` POST endpoint kills the process. UI shows "Kill" button in header (hidden after process exits).

### Stdin Input
**Status**: ✅ Implemented  
`/stdin` POST endpoint writes to `proc.stdin`. UI has text input + Send button (hidden after process exits).

### Combined / Interleaved View
**Status**: ✅ Implemented  
Third "Combined" panel shows stdout (teal) and stderr (red, ANSI colored) interleaved in chronological order using typed SSE events.

### Process Status in Header
**Status**: ✅ Implemented  
`/status` JSON endpoint reports `{running, exitCode}`. Header shows live indicator: "● Running" (green) / "● Exited (N)" (red). Button/input hidden on exit.

### Auto-scroll Toggle
**Status**: ✅ Implemented  
"Pause / Resume" toggle button in tabs bar. When paused, new data arrives but terminal doesn't auto-scroll.

### Download Output
**Status**: ✅ Implemented  
"Save" button downloads current panel's terminal buffer as `{stdout,stderr,combined}-output.txt`.

### Configurable Port via CLI flag
**Status**: ✅ Implemented  
`--port N` flag parsed from `Bun.argv`, validates range 1-65535.

### Auto-reconnect on Disconnect
**Status**: ✅ Implemented  
SSE connections use exponential backoff (1s → 2s → 4s... max 30s) with incremental replay via `?from=N` parameter.

---

## Future Ideas

### Search (Medium Value)
Load xterm's `SearchAddon` (already a separate package). Add Ctrl+F or a search bar that calls `searchAddon.findNext(query)`.

### Timestamps Toggle (Low Value)
Optionally prefix each line with a relative or absolute timestamp. Requires server-side tagging with a timestamp field in the SSE event.

---

## Architecture Notes

- Critical files: `server.ts` (only source file)
- No build step needed — Bun runs TypeScript directly
- All HTML/CSS/JS is embedded as a template literal in `server.ts`
- Terminal library: xterm.js 5.3.0 with FitAddon
- Status polling: 1-second interval via `/status` endpoint
- SSE streams: `/stdout`, `/stderr`, `/combined` with `?from=N` for replay
- History buffers: `stdoutBuffer`, `stderrBuffer`, `combinedBuffer` arrays for late-connecting clients
