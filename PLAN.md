# proc-web: Prioritized Implementation Roadmap

This roadmap turns the current MVP into a more feature-complete and robust tool.

## Guiding priorities

1. **Do not lose output**
2. **Do not exhaust memory on long-running commands**
3. **Make reconnects and long-lived sessions reliable**
4. **Improve security before expanding remote access**
5. **Add true terminal behavior for interactive apps**
6. **Add session UX and quality-of-life features after the core is solid**

---

## Phase 0: Immediate quick wins

Small, high-value changes with low implementation risk.

### 0.1 Fix UTF-8 streaming decode
**Priority:** Critical  
**Why:** Current chunk decoding can corrupt multibyte characters if a UTF-8 sequence is split across chunks.

**Tasks**
- [x] Use streaming `TextDecoder.decode(chunk, { stream: true })`
- [x] Flush decoders when stdout/stderr streams end
- [x] Add a test case or manual validation using Unicode-heavy output

**Done when**
- [x] Non-ASCII output is rendered correctly under chunk boundaries

### 0.2 Add SSE heartbeats
**Priority:** High  
**Why:** Idle SSE connections may be dropped by browsers, proxies, or network layers.

**Tasks**
- [x] Send periodic SSE comment heartbeats such as `: ping\n\n`
- [x] Keep heartbeat interval configurable
- [x] Ensure heartbeats do not affect replay offsets

**Done when**
- [x] Quiet commands stay connected reliably over long idle periods

### 0.3 Improve process / pipe error handling
**Priority:** High  
**Why:** Startup failures and stream failures should produce clear status for the browser and logs.

**Tasks**
- [x] Wrap process startup in explicit error handling
- [x] Add `.catch()` handling to `pipeTo(...)`
- [x] Distinguish spawn failure from non-zero exit
- [x] Surface failures in UI status and logs

**Done when**
- [x] Broken commands fail cleanly with a clear message instead of silent failure

### 0.4 Make network IP detection robust
**Priority:** Medium  
**Why:** Current interface-name detection is brittle.

**Tasks**
- [x] Iterate all network interfaces
- [x] Show non-internal IPv4 addresses
- [x] Prefer localhost by default in startup output

**Done when**
- [x] Startup output works across more Linux/WSL/network setups

---

## Phase 1: Core robustness

These changes protect the app under long-running and high-volume workloads.

### 1.1 Bound in-memory history
**Priority:** Critical  
**Why:** Current stdout/stderr/combined history arrays grow forever and can exhaust memory.

**Tasks**
- [x] Introduce configurable retention limits by bytes and/or chunks
- [x] Keep only a recent replay window in memory
- [x] Track total buffered bytes
- [x] Clearly document retention behavior

**Done when**
- [x] Long-running commands no longer cause unbounded memory growth

### 1.2 Add disk-backed log persistence
**Priority:** Critical  
**Why:** Full output should survive long runs, client disconnects, and future session UX.

**Tasks**
- [x] Append stdout/stderr/combined events to disk
- [x] Persist metadata: command, start time, exit code, duration
- [x] Use a simple format such as JSONL or append-only text/event logs
- [x] Keep recent tail in memory, full history on disk

**Done when**
- [x] Full logs can be replayed/downloaded even after large output volumes

### 1.3 Introduce structured event IDs
**Priority:** High  
**Why:** Chunk-count offsets work, but proper event IDs are more robust and standard.

**Tasks**
- [x] Assign monotonically increasing event IDs
- [x] Emit SSE `id:` fields
- [x] Support reconnect with `Last-Event-ID`
- [x] Keep replay logic compatible with bounded memory and disk logs

**Done when**
- [x] Reconnects resume accurately without duplicate or skipped output

### 1.4 Handle slow clients gracefully
**Priority:** High  
**Why:** Slow or stalled clients should not degrade the whole server.

**Tasks**
- [x] Detect failed/broken client streams reliably
- [x] Add cleanup and backpressure-aware handling where possible
- [x] Drop lagging clients safely
- [x] Ensure one slow client does not grow server memory unboundedly

**Done when**
- [x] High-throughput commands remain stable with multiple viewers

### 1.5 Improve shutdown lifecycle
**Priority:** High  
**Why:** Child and server cleanup should be deterministic.

**Tasks**
- [x] Track and cancel pending shutdown timers when clients reconnect
- [x] Forward server SIGINT/SIGTERM to child process
- [x] Prevent orphan processes on server exit
- [x] Ensure shutdown logic runs once

**Done when**
- [x] Server and child process exit cleanly in normal and interrupted flows

---

## Phase 2: Security and safe remote use

Before making remote access richer, lock down control surfaces.

### 2.1 Default to localhost binding
**Priority:** High  
**Why:** Binding to `0.0.0.0` by default exposes output and process controls on the network.

**Tasks**
- Bind to `127.0.0.1` by default
- Add explicit `--host 0.0.0.0` for remote access
- Update README usage examples

**Done when**
- Local usage is safe by default

### 2.2 Add lightweight authentication / access tokens
**Priority:** High  
**Why:** `/kill` and `/stdin` should not be publicly writable if remote access is enabled.

**Tasks**
- Add optional session token in query/header/cookie
- Require token for control endpoints
- Support read-only mode for viewers

**Done when**
- Remote viewers cannot control processes without authorization

### 2.3 Separate viewer and controller permissions
**Priority:** Medium  
**Why:** Multi-client support becomes much more useful with permission separation.

**Tasks**
- Define read-only and control capabilities
- Hide/disable kill and stdin in read-only mode
- Document sharing model

**Done when**
- Sessions can be shared safely without giving everyone control

---

## Phase 3: Feature completeness for terminal workflows

This phase closes the gap between “log viewer” and “real browser terminal”.

### 3.1 Add PTY mode
**Priority:** High  
**Why:** Many interactive programs need a TTY to behave correctly.

**Tasks**
- Add optional PTY-backed child execution mode
- Preserve current pipe mode for simple non-interactive commands
- Decide CLI/API for selecting mode

**Done when**
- Interactive programs behave like they do in a real terminal

### 3.2 Support terminal resize propagation
**Priority:** High  
**Why:** PTY mode is incomplete without resize support.

**Tasks**
- Send rows/cols from browser to server
- Resize the child PTY on terminal/container resize
- Handle reconnect/resume with latest dimensions

**Done when**
- Full-screen TUIs and wrapped output resize correctly

### 3.3 Improve stdin / signal controls
**Priority:** Medium  
**Why:** Current stdin always appends newline and control options are minimal.

**Tasks**
- Add “send raw” vs “send line”
- Add Ctrl+C / Ctrl+D helpers
- Add signal actions: SIGINT, SIGTERM, SIGKILL
- Add restart / rerun support

**Done when**
- Interactive and long-running processes can be controlled cleanly from the UI

---

## Phase 4: Sessions and persistence UX

These features make the tool feel complete for repeated use.

### 4.1 Introduce sessions
**Priority:** High  
**Why:** One-server-one-process is limiting for real usage.

**Tasks**
- Assign session IDs
- Store session metadata
- Add routes/pages for viewing specific sessions
- Support active and completed sessions

**Done when**
- Users can revisit and share specific process runs

### 4.2 Session list / history page
**Priority:** Medium  
**Why:** Persisted logs become much more useful when discoverable.

**Tasks**
- Add a simple index page of sessions
- Show command, status, start time, duration, exit code
- Allow reopening completed sessions

**Done when**
- Users can browse previous runs without knowing raw URLs

### 4.3 Restart / rerun flows
**Priority:** Medium  
**Why:** A common next action after failure or completion is rerunning the same command.

**Tasks**
- Add rerun button for completed sessions
- Preserve command, cwd, and env configuration where applicable
- Create a new session for each rerun

**Done when**
- Repeated command workflows are one click away

### 4.4 Full log export
**Priority:** Medium  
**Why:** Current download uses the terminal buffer only.

**Tasks**
- Export raw stdout, raw stderr, combined log, and metadata
- Support downloading from persisted server-side history
- Ensure exports are not limited by client scrollback

**Done when**
- Users can reliably retrieve complete logs for large jobs

---

## Phase 5: Output usability improvements

These are quality-of-life features that improve day-to-day usage.

### 5.1 Timestamps toggle
**Priority:** Medium  
**Why:** Very useful for debugging and long-running tasks.

**Tasks**
- Add absolute and relative timestamp modes
- Decide whether timestamps are per chunk or per line
- Keep raw export unaffected by display-only timestamps, or provide both modes

**Done when**
- Users can correlate output timing visually

### 5.2 Better output filtering and navigation
**Priority:** Medium  
**Why:** Logs become harder to navigate as sessions get larger.

**Tasks**
- Add stdout/stderr filtering in combined view
- Add text/regex highlight filter
- Add wrap/no-wrap toggle
- Add jump-to-next-error / previous-error
- Add line counts or chunk counts where useful

**Done when**
- Large outputs are easier to inspect in-browser

### 5.3 Improved client rendering performance
**Priority:** Medium  
**Why:** Extremely chatty commands can stress the browser.

**Tasks**
- Batch terminal writes per animation frame
- Coalesce small chunks
- Tune scrollback configuration
- Avoid unnecessary rendering on hidden tabs

**Done when**
- High-volume output stays responsive in the browser

### 5.4 Visual polish and UX refinements
**Priority:** Low  
**Why:** Improves perceived completeness.

**Tasks**
- Add mobile/responsive improvements
- Improve status display with runtime and bytes streamed
- Add theme polish and better button states
- Show viewer count / connection status

**Done when**
- The app feels more finished and easier to use

---

## Phase 6: Packaging and deployability

These changes improve reproducibility and production readiness.

### 6.1 Serve frontend assets locally
**Priority:** Medium  
**Why:** CDN dependencies reduce offline reliability and reproducibility.

**Tasks**
- Add explicit dependency for `xterm-addon-search`
- Serve xterm assets locally instead of via CDN
- Pin versions consistently

**Done when**
- The app works offline and has reproducible frontend assets

### 6.2 CLI / config cleanup
**Priority:** Medium  
**Why:** More features need cleaner configuration.

**Tasks**
- Add options for host, auth token, retention, log directory, idle timeout, PTY mode
- Improve usage/help text
- Validate configuration consistently

**Done when**
- New features are discoverable and configurable from the CLI

### 6.3 Automated testing
**Priority:** Medium  
**Why:** The app now has enough stateful behavior to justify tests.

**Tasks**
- Add tests for argument parsing and replay logic
- Add tests for UTF-8 chunk boundary handling
- Add tests for reconnect and event ID resume behavior
- Add tests for retention limits and persisted replay

**Done when**
- Core streaming and replay behavior is protected against regressions

---

## Recommended implementation order

If work is done incrementally, use this order:

1. Fix UTF-8 streaming decode
2. Add better spawn/pipe error handling
3. Add SSE heartbeats
4. Bound in-memory history
5. Add disk-backed log persistence
6. Introduce structured event IDs and reconnect resume
7. Improve slow-client cleanup and shutdown lifecycle
8. Default to localhost binding and add `--host`
9. Add auth token and read-only/view-only mode
10. Add PTY mode
11. Add terminal resize propagation
12. Improve stdin and signal controls
13. Introduce sessions and persisted session pages
14. Add rerun/restart and full export
15. Add timestamps toggle
16. Add output filtering/navigation improvements
17. Serve frontend assets locally
18. Add automated tests

---

## Good first milestone

A strong next milestone would be:

- UTF-8 decode fix
- SSE heartbeats
- bounded memory
- disk-backed logs
- localhost-by-default binding
- basic auth token for control endpoints

That would significantly improve robustness and safety without requiring a major redesign.
