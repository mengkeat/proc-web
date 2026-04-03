import { spawn } from "bun";

// Parse --port flag and extract command
let PORT = 3000;
const rawArgs = Bun.argv.slice(2);
const portIdx = rawArgs.indexOf("--port");
if (portIdx !== -1 && rawArgs[portIdx + 1]) {
  const p = parseInt(rawArgs[portIdx + 1], 10);
  if (!isNaN(p) && p > 0 && p <= 65535) PORT = p;
  else { console.error("Invalid port number"); process.exit(1); }
}

const command: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--port") { i++; continue; }
  command.push(rawArgs[i]);
}

if (command.length === 0) {
  console.error("Usage: bun run server.ts [--port N] <command> [args...]");
  console.error("Example: bun run server.ts ls -la");
  process.exit(1);
}

const os = require("os") as typeof import("os");
const wslIP =
  os.networkInterfaces()["eth0"]?.[0]?.address ||
  os.networkInterfaces()["ens3"]?.[0]?.address ||
  os.networkInterfaces()["enp0s3"]?.[0]?.address ||
  null;

console.log(`Starting: ${command.join(" ")}`);
console.log(`Open http://localhost:${PORT} in your browser`);
if (wslIP) console.log(`Open http://${wslIP}:${PORT} in your Windows browser`);

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const cmdHtml = escapeHtml(command.join(" "));

// Process state
let processCompleted = false;
let exitCode: number | null = null;

// History buffers (for late-connecting / reconnecting clients)
const stdoutBuffer: string[] = [];
const stderrBuffer: string[] = [];
const combinedBuffer: { type: "stdout" | "stderr"; data: string }[] = [];

// Multi-client SSE controller sets
const stdoutCtls = new Set<ReadableStreamDefaultController>();
const stderrCtls = new Set<ReadableStreamDefaultController>();
const combinedCtls = new Set<ReadableStreamDefaultController>();

let activeConnections = 0;
const enc = new TextEncoder();

function sseBytes(data: string, eventType?: string): Uint8Array {
  const b64 = btoa(unescape(encodeURIComponent(data)));
  const evtLine = eventType ? `event: ${eventType}\n` : "";
  return enc.encode(`${evtLine}data: ${b64}\n\n`);
}

function sendEvent(ctrl: ReadableStreamDefaultController, data: string, eventType?: string) {
  try { ctrl.enqueue(sseBytes(data, eventType)); } catch { /* client disconnected */ }
}

function broadcast(ctls: Set<ReadableStreamDefaultController>, data: string, eventType?: string) {
  if (!ctls.size) return;
  const b64 = btoa(unescape(encodeURIComponent(data)));
  const evtLine = eventType ? `event: ${eventType}\n` : "";
  const message = `${evtLine}data: ${b64}\n\n`;
  const failed: ReadableStreamDefaultController[] = [];
  for (const ctrl of ctls) {
    try { ctrl.enqueue(enc.encode(message)); } catch { failed.push(ctrl); }
  }
  for (const ctrl of failed) ctls.delete(ctrl);
}

function makeSSEStream(
  ctls: Set<ReadableStreamDefaultController>,
  replay: (ctrl: ReadableStreamDefaultController) => void
): ReadableStream {
  activeConnections++;
  let mine!: ReadableStreamDefaultController;
  return new ReadableStream({
    start(ctrl) { mine = ctrl; ctls.add(ctrl); replay(ctrl); },
    cancel() { activeConnections--; ctls.delete(mine); checkShutdown(); },
  });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

// Spawn the process
const proc = spawn({ cmd: command, stdout: "pipe", stderr: "pipe", stdin: "pipe" });

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html" } });
    }

    if (pathname === "/status") {
      return new Response(
        JSON.stringify({ running: !processCompleted, exitCode }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (pathname === "/kill" && req.method === "POST") {
      if (!processCompleted) proc.kill();
      return new Response(`{"ok":true}`, { headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/stdin" && req.method === "POST") {
      if (!processCompleted) {
        const text = await req.text();
        try { proc.stdin.write(text + "\n"); await proc.stdin.flush(); } catch { /* ignore */ }
      }
      return new Response(`{"ok":true}`, { headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/stdout") {
      const from = Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0);
      return new Response(makeSSEStream(stdoutCtls, ctrl => {
        for (let i = from; i < stdoutBuffer.length; i++) sendEvent(ctrl, stdoutBuffer[i]);
        if (processCompleted) sendEvent(ctrl, `\r\n[Process exited with code ${exitCode}]\r\n`);
      }), { headers: SSE_HEADERS });
    }

    if (pathname === "/stderr") {
      const from = Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0);
      return new Response(makeSSEStream(stderrCtls, ctrl => {
        for (let i = from; i < stderrBuffer.length; i++) sendEvent(ctrl, stderrBuffer[i]);
        if (processCompleted) sendEvent(ctrl, `\r\n[Process exited with code ${exitCode}]\r\n`);
      }), { headers: SSE_HEADERS });
    }

    if (pathname === "/combined") {
      const from = Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0);
      return new Response(makeSSEStream(combinedCtls, ctrl => {
        for (let i = from; i < combinedBuffer.length; i++) {
          const { type, data } = combinedBuffer[i];
          sendEvent(ctrl, data, type);
        }
        if (processCompleted) sendEvent(ctrl, `\r\n[Process exited with code ${exitCode}]\r\n`);
      }), { headers: SSE_HEADERS });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// Stream stdout
proc.stdout.pipeTo(new WritableStream({
  write(chunk) {
    const data = new TextDecoder().decode(chunk);
    stdoutBuffer.push(data);
    broadcast(stdoutCtls, data);
    combinedBuffer.push({ type: "stdout", data });
    broadcast(combinedCtls, data, "stdout");
  },
}));

// Stream stderr
proc.stderr.pipeTo(new WritableStream({
  write(chunk) {
    const data = new TextDecoder().decode(chunk);
    stderrBuffer.push(data);
    broadcast(stderrCtls, data);
    combinedBuffer.push({ type: "stderr", data });
    broadcast(combinedCtls, data, "stderr");
  },
}));

// Handle process exit
proc.exited.then((code) => {
  exitCode = code;
  processCompleted = true;
  const msg = `\r\n[Process exited with code ${code}]\r\n`;
  broadcast(stdoutCtls, msg);
  broadcast(stderrCtls, msg);
  broadcast(combinedCtls, msg);
  console.log(`\nProcess exited with code ${code}`);
  checkShutdown();
});

function checkShutdown() {
  if (processCompleted && activeConnections === 0) {
    setTimeout(() => {
      if (activeConnections === 0) {
        console.log("\nAll clients disconnected, shutting down...");
        server.stop();
      }
    }, 5000);
  }
}

// Auto-shutdown if no clients connect within 60s
setTimeout(() => {
  if (activeConnections === 0) {
    console.log("\nNo clients connected, shutting down...");
    server.stop();
  }
}, 60000);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>proc-web: ${cmdHtml}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e;
      color: #fff;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: #2d2d2d;
      padding: 8px 16px;
      border-bottom: 1px solid #3d3d3d;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .logo { font-size: 14px; font-weight: 600; color: #4ec9b0; flex-shrink: 0; }
    .command {
      font-family: Monaco, Menlo, 'Courier New', monospace;
      font-size: 12px;
      color: #d4d4d4;
      background: #333;
      padding: 3px 8px;
      border-radius: 4px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    #status-el { font-size: 12px; white-space: nowrap; }
    .status-running { color: #4ec9b0; }
    .status-exited { color: #f14c4c; }
    .btn {
      background: #3c3c3c;
      color: #d4d4d4;
      border: 1px solid #555;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .btn:hover { background: #4a4a4a; }
    .btn-danger { background: #5a1a1a; border-color: #7a2a2a; color: #ff6b6b; }
    .btn-danger:hover { background: #6a2020; }
    .tabs-bar {
      background: #252526;
      border-bottom: 1px solid #3d3d3d;
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .tab-list { display: flex; }
    .tab {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: #888;
      padding: 8px 18px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.5px;
    }
    .tab:hover { color: #ccc; }
    .tab.active { color: #fff; border-bottom-color: #4ec9b0; }
    .tab-actions { display: flex; align-items: center; gap: 6px; padding: 0 12px; }
    .panels { flex: 1; overflow: hidden; }
    .panel { display: none; height: 100%; flex-direction: column; }
    .panel.active { display: flex; }
    .terminal-container { flex: 1; padding: 8px; overflow: hidden; }
    .stdin-area {
      background: #252526;
      border-top: 1px solid #3d3d3d;
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .stdin-label { font-size: 11px; color: #888; flex-shrink: 0; font-family: Monaco, Menlo, monospace; }
    .stdin-area input {
      flex: 1;
      background: #1e1e1e;
      border: 1px solid #4a4a4a;
      color: #d4d4d4;
      padding: 5px 10px;
      border-radius: 4px;
      font-family: Monaco, Menlo, 'Courier New', monospace;
      font-size: 13px;
      min-width: 0;
    }
    .stdin-area input:focus { outline: none; border-color: #4ec9b0; }
  </style>
</head>
<body>
  <header>
    <span class="logo">proc-web</span>
    <span class="command" title="${cmdHtml}">${cmdHtml}</span>
    <div class="header-right">
      <span id="status-el" class="status-running">● Running</span>
      <button id="kill-btn" class="btn btn-danger" onclick="killProcess()">Kill</button>
    </div>
  </header>

  <div class="tabs-bar">
    <div class="tab-list">
      <button class="tab active" data-tab="stdout" onclick="switchTab('stdout')">STDOUT</button>
      <button class="tab" data-tab="stderr" onclick="switchTab('stderr')">STDERR</button>
      <button class="tab" data-tab="combined" onclick="switchTab('combined')">COMBINED</button>
    </div>
    <div class="tab-actions">
      <button id="scroll-btn" class="btn" onclick="toggleScroll()">⏸ Pause</button>
      <button class="btn" onclick="downloadOutput()">⬇ Save</button>
    </div>
  </div>

  <div class="panels">
    <div class="panel active" id="panel-stdout">
      <div class="terminal-container" id="stdout-terminal"></div>
    </div>
    <div class="panel" id="panel-stderr">
      <div class="terminal-container" id="stderr-terminal"></div>
    </div>
    <div class="panel" id="panel-combined">
      <div class="terminal-container" id="combined-terminal"></div>
    </div>
  </div>

  <div id="stdin-area" class="stdin-area">
    <span class="stdin-label">stdin:</span>
    <input type="text" id="stdin-input" placeholder="Type input and press Enter…" autocomplete="off" spellcheck="false" />
    <button class="btn" onclick="sendStdin()">Send</button>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const TERM_BASE = {
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Courier New", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      convertEol: true,
      scrollback: 10000,
    };

    const stdoutTerm = new Terminal(TERM_BASE);
    const stderrTerm = new Terminal({ ...TERM_BASE, theme: { background: '#1e1e1e', foreground: '#f14c4c' } });
    const combinedTerm = new Terminal(TERM_BASE);

    const stdoutFit = new FitAddon.FitAddon();
    const stderrFit = new FitAddon.FitAddon();
    const combinedFit = new FitAddon.FitAddon();

    stdoutTerm.loadAddon(stdoutFit);
    stderrTerm.loadAddon(stderrFit);
    combinedTerm.loadAddon(combinedFit);

    stdoutTerm.open(document.getElementById('stdout-terminal'));
    stderrTerm.open(document.getElementById('stderr-terminal'));
    combinedTerm.open(document.getElementById('combined-terminal'));

    const terms = { stdout: stdoutTerm, stderr: stderrTerm, combined: combinedTerm };
    const fits  = { stdout: stdoutFit,  stderr: stderrFit,  combined: combinedFit  };

    // Only fit the active panel (hidden panels have 0 dimensions)
    function fitActive() {
      try { fits[currentTab].fit(); } catch (_) {}
    }
    fitActive();
    window.addEventListener('resize', fitActive);

    // --- Tab switching ---
    let currentTab = 'stdout';
    function switchTab(name) {
      currentTab = name;
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.panel').forEach(p =>
        p.classList.toggle('active', p.id === 'panel-' + name));
      try { fits[name].fit(); } catch (_) {}
      if (autoScroll) terms[name].scrollToBottom();
    }

    // --- Auto-scroll ---
    let autoScroll = true;
    function toggleScroll() {
      autoScroll = !autoScroll;
      const btn = document.getElementById('scroll-btn');
      btn.textContent = autoScroll ? '\\u23f8 Pause' : '\\u25b6 Resume';
      if (autoScroll) Object.values(terms).forEach(t => t.scrollToBottom());
    }

    function writeTerm(term, data) {
      term.write(data);
      if (autoScroll) term.scrollToBottom();
    }

    // --- Process status polling ---
    let processExited = false;
    function updateStatus() {
      fetch('/status').then(r => r.json()).then(s => {
        const el = document.getElementById('status-el');
        if (s.running) {
          el.textContent = '\\u25cf Running';
          el.className = 'status-running';
        } else {
          processExited = true;
          el.textContent = '\\u25cf Exited (' + s.exitCode + ')';
          el.className = 'status-exited';
          document.getElementById('kill-btn').style.display = 'none';
          document.getElementById('stdin-area').style.display = 'none';
          clearInterval(statusTimer);
        }
      }).catch(() => {});
    }
    const statusTimer = setInterval(updateStatus, 1000);
    updateStatus();

    // --- Kill ---
    function killProcess() {
      fetch('/kill', { method: 'POST' }).catch(() => {});
    }

    // --- Stdin ---
    function sendStdin() {
      const inp = document.getElementById('stdin-input');
      const text = inp.value;
      if (!text) return;
      fetch('/stdin', { method: 'POST', body: text }).catch(() => {});
      inp.value = '';
    }
    document.getElementById('stdin-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendStdin();
    });

    // --- Download current tab output ---
    function downloadOutput() {
      const term = terms[currentTab];
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const blob = new Blob([lines.join('\\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = currentTab + '-output.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // --- SSE helpers ---
    function decode(b64) {
      return decodeURIComponent(escape(atob(b64)));
    }

    // SSE connection with exponential-backoff reconnect + incremental replay via ?from=N
    function connectSSE(getUrl, setup) {
      let delay = 1000;
      function connect() {
        const es = new EventSource(getUrl());
        es.onopen = () => { delay = 1000; };
        setup(es);
        es.onerror = () => {
          es.close();
          if (!processExited) {
            setTimeout(connect, delay);
            delay = Math.min(delay * 2, 30000);
          }
        };
      }
      connect();
    }

    // Counters track our position in the server-side buffer arrays
    // so reconnects resume from where we left off without duplicates
    let soIdx = 0, seIdx = 0, coIdx = 0;

    connectSSE(() => '/stdout?from=' + soIdx, es => {
      es.onmessage = e => { soIdx++; writeTerm(stdoutTerm, decode(e.data)); };
    });

    connectSSE(() => '/stderr?from=' + seIdx, es => {
      es.onmessage = e => { seIdx++; writeTerm(stderrTerm, decode(e.data)); };
    });

    connectSSE(() => '/combined?from=' + coIdx, es => {
      // Typed events: stdout (default color) and stderr (red)
      es.addEventListener('stdout', e => {
        coIdx++;
        writeTerm(combinedTerm, decode(e.data));
      });
      es.addEventListener('stderr', e => {
        coIdx++;
        writeTerm(combinedTerm, '\\x1b[31m' + decode(e.data) + '\\x1b[0m');
      });
      // Default message type: process exit notification
      es.onmessage = e => writeTerm(combinedTerm, decode(e.data));
    });
  </script>
</body>
</html>`;
