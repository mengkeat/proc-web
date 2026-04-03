import { spawn } from "bun";

// --- CLI argument parsing ---

function parseArgs(argv: string[]): { port: number; command: string[] } {
  const args = argv.slice(2);
  let port = 3000;
  const command: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const portValue = parseInt(args[++i], 10);
      if (isNaN(portValue) || portValue < 1 || portValue > 65535) {
        console.error("Invalid port number");
        process.exit(1);
      }
      port = portValue;
    } else {
      command.push(args[i]);
    }
  }

  if (command.length === 0) {
    console.error("Usage: bun run server.ts [--port N] <command> [args...]");
    console.error("Example: bun run server.ts ls -la");
    process.exit(1);
  }

  return { port, command };
}

const { port: PORT, command } = parseArgs(Bun.argv);

// --- Startup info ---

function getLocalNetworkIP(): string | null {
  const os = require("os") as typeof import("os");
  const interfaces = os.networkInterfaces();
  for (const name of ["eth0", "ens3", "enp0s3"]) {
    const address = interfaces[name]?.[0]?.address;
    if (address) return address;
  }
  return null;
}

console.log(`Starting: ${command.join(" ")}`);
console.log(`Open http://localhost:${PORT} in your browser`);
const localIP = getLocalNetworkIP();
if (localIP) console.log(`Open http://${localIP}:${PORT} in your Windows browser`);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const commandHtml = escapeHtml(command.join(" "));

// --- Process state ---

let processExited = false;
let processExitCode: number | null = null;

// Buffers for late-connecting / reconnecting clients
const stdoutHistory: string[] = [];
const stderrHistory: string[] = [];
const combinedHistory: { type: "stdout" | "stderr"; data: string }[] = [];

// Active SSE client connections per stream
const stdoutClients = new Set<ReadableStreamDefaultController>();
const stderrClients = new Set<ReadableStreamDefaultController>();
const combinedClients = new Set<ReadableStreamDefaultController>();

let activeConnectionCount = 0;
const textEncoder = new TextEncoder();

// --- SSE helpers ---

function encodeSSE(data: string, eventType?: string): Uint8Array {
  const base64 = btoa(unescape(encodeURIComponent(data)));
  const eventLine = eventType ? `event: ${eventType}\n` : "";
  return textEncoder.encode(`${eventLine}data: ${base64}\n\n`);
}

function sendToClient(client: ReadableStreamDefaultController, data: string, eventType?: string) {
  try { client.enqueue(encodeSSE(data, eventType)); } catch { /* client disconnected */ }
}

function broadcastToClients(clients: Set<ReadableStreamDefaultController>, data: string, eventType?: string) {
  if (!clients.size) return;
  const encoded = encodeSSE(data, eventType);
  for (const client of clients) {
    try { client.enqueue(encoded); } catch { clients.delete(client); }
  }
}

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

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

// --- Spawn the child process ---

const proc = spawn({ cmd: command, stdout: "pipe", stderr: "pipe", stdin: "pipe" });

// --- HTTP server ---

function parseReplayOffset(url: URL): number {
  return Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0);
}

const exitMessage = () => `\r\n[Process exited with code ${processExitCode}]\r\n`;

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
      return Response.json({ running: !processExited, exitCode: processExitCode });
    }

    if (pathname === "/kill" && req.method === "POST") {
      if (!processExited) proc.kill();
      return Response.json({ ok: true });
    }

    if (pathname === "/stdin" && req.method === "POST") {
      if (!processExited) {
        const text = await req.text();
        try { proc.stdin.write(text + "\n"); await proc.stdin.flush(); } catch { /* closed */ }
      }
      return Response.json({ ok: true });
    }

    if (pathname === "/stdout") {
      const from = parseReplayOffset(url);
      return new Response(createSSEStream(stdoutClients, client => {
        for (let i = from; i < stdoutHistory.length; i++) sendToClient(client, stdoutHistory[i]);
        if (processExited) sendToClient(client, exitMessage());
      }), { headers: SSE_HEADERS });
    }

    if (pathname === "/stderr") {
      const from = parseReplayOffset(url);
      return new Response(createSSEStream(stderrClients, client => {
        for (let i = from; i < stderrHistory.length; i++) sendToClient(client, stderrHistory[i]);
        if (processExited) sendToClient(client, exitMessage());
      }), { headers: SSE_HEADERS });
    }

    if (pathname === "/combined") {
      const from = parseReplayOffset(url);
      return new Response(createSSEStream(combinedClients, client => {
        for (let i = from; i < combinedHistory.length; i++) {
          const { type, data } = combinedHistory[i];
          sendToClient(client, data, type);
        }
        if (processExited) sendToClient(client, exitMessage());
      }), { headers: SSE_HEADERS });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// --- Pipe process output to SSE clients ---

const textDecoder = new TextDecoder();

proc.stdout.pipeTo(new WritableStream({
  write(chunk) {
    const data = textDecoder.decode(chunk);
    stdoutHistory.push(data);
    broadcastToClients(stdoutClients, data);
    combinedHistory.push({ type: "stdout", data });
    broadcastToClients(combinedClients, data, "stdout");
  },
}));

proc.stderr.pipeTo(new WritableStream({
  write(chunk) {
    const data = textDecoder.decode(chunk);
    stderrHistory.push(data);
    broadcastToClients(stderrClients, data);
    combinedHistory.push({ type: "stderr", data });
    broadcastToClients(combinedClients, data, "stderr");
  },
}));

// --- Process lifecycle ---

proc.exited.then((code) => {
  processExitCode = code;
  processExited = true;
  const message = exitMessage();
  broadcastToClients(stdoutClients, message);
  broadcastToClients(stderrClients, message);
  broadcastToClients(combinedClients, message);
  console.log(`\nProcess exited with code ${code}`);
  shutdownIfIdle();
});

function shutdownIfIdle() {
  if (!processExited || activeConnectionCount > 0) return;
  setTimeout(() => {
    if (activeConnectionCount === 0) {
      console.log("\nAll clients disconnected, shutting down...");
      server.stop();
    }
  }, 5000);
}

setTimeout(() => {
  if (activeConnectionCount === 0) {
    console.log("\nNo clients connected, shutting down...");
    server.stop();
  }
}, 60000);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>proc-web: ${commandHtml}</title>
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
    .search-bar {
      display: none;
      background: #252526;
      border-bottom: 1px solid #3d3d3d;
      padding: 6px 12px;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .search-bar.visible { display: flex; }
    .search-bar input {
      background: #1e1e1e;
      border: 1px solid #4a4a4a;
      color: #d4d4d4;
      padding: 4px 8px;
      border-radius: 4px;
      font-family: Monaco, Menlo, 'Courier New', monospace;
      font-size: 13px;
      width: 260px;
    }
    .search-bar input:focus { outline: none; border-color: #4ec9b0; }
    .search-bar .search-count { font-size: 11px; color: #888; min-width: 20px; }
  </style>
</head>
<body>
  <header>
    <span class="logo">proc-web</span>
    <span class="command" title="${commandHtml}">${commandHtml}</span>
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
      <button class="btn" onclick="toggleSearch()">🔍 Search</button>
      <button id="scroll-btn" class="btn" onclick="toggleScroll()">⏸ Pause</button>
      <button class="btn" onclick="downloadOutput()">⬇ Save</button>
    </div>
  </div>

  <div id="search-bar" class="search-bar">
    <input type="text" id="search-input" placeholder="Search…" autocomplete="off" spellcheck="false" />
    <button class="btn" onclick="searchPrev()">▲</button>
    <button class="btn" onclick="searchNext()">▼</button>
    <span id="search-count" class="search-count"></span>
    <button class="btn" onclick="closeSearch()">✕</button>
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
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-search@0.13.0/lib/xterm-addon-search.js"></script>
  <script>
    const TERMINAL_OPTIONS = {
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Courier New", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      convertEol: true,
      scrollback: 10000,
    };

    function createPanel(elementId, terminalOptions) {
      const terminal = new Terminal(terminalOptions || TERMINAL_OPTIONS);
      const fitAddon = new FitAddon.FitAddon();
      const searchAddon = new SearchAddon.SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.open(document.getElementById(elementId));
      return { terminal, fitAddon, searchAddon };
    }

    const panels = {
      stdout:   createPanel('stdout-terminal'),
      stderr:   createPanel('stderr-terminal', { ...TERMINAL_OPTIONS, theme: { background: '#1e1e1e', foreground: '#f14c4c' } }),
      combined: createPanel('combined-terminal'),
    };

    function fitActivePanel() {
      try { panels[currentTab].fitAddon.fit(); } catch (_) {}
    }
    fitActivePanel();
    window.addEventListener('resize', fitActivePanel);

    // --- Tab switching ---
    let currentTab = 'stdout';
    function switchTab(name) {
      currentTab = name;
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.panel').forEach(p =>
        p.classList.toggle('active', p.id === 'panel-' + name));
      try { panels[name].fitAddon.fit(); } catch (_) {}
      if (autoScroll) panels[name].terminal.scrollToBottom();
    }

    // --- Auto-scroll ---
    let autoScroll = true;
    function toggleScroll() {
      autoScroll = !autoScroll;
      const btn = document.getElementById('scroll-btn');
      btn.textContent = autoScroll ? '\\u23f8 Pause' : '\\u25b6 Resume';
      if (autoScroll) Object.values(panels).forEach(p => p.terminal.scrollToBottom());
    }

    function writeToTerminal(terminal, data) {
      terminal.write(data);
      if (autoScroll) terminal.scrollToBottom();
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
      const { terminal } = panels[currentTab];
      const buf = terminal.buffer.active;
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

    // --- Search ---
    let searchVisible = false;
    function toggleSearch() {
      searchVisible = !searchVisible;
      const bar = document.getElementById('search-bar');
      bar.classList.toggle('visible', searchVisible);
      if (searchVisible) {
        document.getElementById('search-input').focus();
      } else {
        closeSearch();
      }
    }
    function closeSearch() {
      searchVisible = false;
      document.getElementById('search-bar').classList.remove('visible');
      document.getElementById('search-input').value = '';
      document.getElementById('search-count').textContent = '';
      panels[currentTab].searchAddon.clearDecorations();
    }
    function searchNext() {
      const q = document.getElementById('search-input').value;
      if (q) panels[currentTab].searchAddon.findNext(q);
    }
    function searchPrev() {
      const q = document.getElementById('search-input').value;
      if (q) panels[currentTab].searchAddon.findPrevious(q);
    }
    document.getElementById('search-input').addEventListener('input', e => {
      const q = e.target.value;
      if (q) {
        panels[currentTab].searchAddon.findNext(q);
      } else {
        panels[currentTab].searchAddon.clearDecorations();
        document.getElementById('search-count').textContent = '';
      }
    });
    document.getElementById('search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.shiftKey ? searchPrev() : searchNext();
      } else if (e.key === 'Escape') {
        closeSearch();
      }
    });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (!searchVisible) toggleSearch();
        else document.getElementById('search-input').focus();
      }
    });

    // --- SSE helpers ---

    function decodeBase64(encoded) {
      return decodeURIComponent(escape(atob(encoded)));
    }

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

    // Track position in server-side history so reconnects resume without duplicates
    let stdoutOffset = 0, stderrOffset = 0, combinedOffset = 0;

    connectSSE(() => '/stdout?from=' + stdoutOffset, source => {
      source.onmessage = e => { stdoutOffset++; writeToTerminal(panels.stdout.terminal, decodeBase64(e.data)); };
    });

    connectSSE(() => '/stderr?from=' + stderrOffset, source => {
      source.onmessage = e => { stderrOffset++; writeToTerminal(panels.stderr.terminal, decodeBase64(e.data)); };
    });

    connectSSE(() => '/combined?from=' + combinedOffset, source => {
      source.addEventListener('stdout', e => {
        combinedOffset++;
        writeToTerminal(panels.combined.terminal, decodeBase64(e.data));
      });
      source.addEventListener('stderr', e => {
        combinedOffset++;
        writeToTerminal(panels.combined.terminal, '\\x1b[31m' + decodeBase64(e.data) + '\\x1b[0m');
      });
      source.onmessage = e => writeToTerminal(panels.combined.terminal, decodeBase64(e.data));
    });
  </script>
</body>
</html>`;
