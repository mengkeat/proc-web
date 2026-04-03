import { spawn } from "bun";

// --- CLI argument parsing ---

function parseArgs(argv: string[]): { port: number; host: string; maxHistory: number; logDir: string | null; token: string | null; pty: boolean; command: string[] } {
  const args = argv.slice(2);
  let port = 3000;
  let host = "127.0.0.1";
  let maxHistory = 10000; // max chunks to keep in memory
  let logDir: string | null = null;
  let token: string | null = null;
  let pty = false;
  const command: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const portValue = parseInt(args[++i], 10);
      if (isNaN(portValue) || portValue < 1 || portValue > 65535) {
        console.error("Invalid port number");
        process.exit(1);
      }
      port = portValue;
    } else if (args[i] === "--max-history") {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1) {
        console.error("Invalid max-history value");
        process.exit(1);
      }
      maxHistory = val;
    } else if (args[i] === "--host") {
      host = args[++i];
      if (!host) {
        console.error("Missing host value");
        process.exit(1);
      }
    } else if (args[i] === "--log-dir") {
      logDir = args[++i];
      if (!logDir) {
        console.error("Missing log-dir path");
        process.exit(1);
      }
    } else if (args[i] === "--token") {
      token = args[++i];
      if (!token) {
        console.error("Missing token value");
        process.exit(1);
      }
    } else if (args[i] === "--pty") {
      pty = true;
    } else {
      command.push(args[i]);
    }
  }

  if (command.length === 0) {
    console.error("Usage: bun run server.ts [--port N] [--host ADDR] [--token TOKEN] [--pty] [--max-history N] [--log-dir DIR] <command> [args...]");
    console.error("Example: bun run server.ts ls -la");
    process.exit(1);
  }

  return { port, host, maxHistory, logDir, token, pty, command };
}

const { port: PORT, host: HOST, maxHistory: MAX_HISTORY, logDir: LOG_DIR, token: AUTH_TOKEN, pty: PTY_MODE, command } = parseArgs(Bun.argv);

// --- Disk-backed log persistence ---

import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

let logSessionDir: string | null = null;
let stdoutLogPath: string | null = null;
let stderrLogPath: string | null = null;
let combinedLogPath: string | null = null;
let metadataPath: string | null = null;
const startTime = Date.now();

if (LOG_DIR) {
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  logSessionDir = join(LOG_DIR, sessionId);
  mkdirSync(logSessionDir, { recursive: true });
  stdoutLogPath = join(logSessionDir, "stdout.log");
  stderrLogPath = join(logSessionDir, "stderr.log");
  combinedLogPath = join(logSessionDir, "combined.log");
  metadataPath = join(logSessionDir, "metadata.json");
  writeFileSync(metadataPath, JSON.stringify({
    command,
    startTime: new Date(startTime).toISOString(),
    pid: process.pid,
  }, null, 2));
}

function appendLog(path: string | null, data: string) {
  if (path) try { appendFileSync(path, data); } catch { /* ignore */ }
}

function updateMetadata(exitCode: number) {
  if (metadataPath) {
    try {
      writeFileSync(metadataPath, JSON.stringify({
        command,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        exitCode,
        pid: process.pid,
      }, null, 2));
    } catch { /* ignore */ }
  }
}

// --- Startup info ---

function getLocalNetworkIPs(): string[] {
  const os = require("os") as typeof import("os");
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        ips.push(entry.address);
      }
    }
  }
  return ips;
}

console.log(`Starting: ${command.join(" ")}`);
console.log(`Open http://localhost:${PORT} in your browser`);
for (const ip of getLocalNetworkIPs()) {
  console.log(`      http://${ip}:${PORT}`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const commandHtml = escapeHtml(command.join(" "));

// --- Process state ---

let processExited = false;
let processExitCode: number | null = null;

// Bounded history buffers - old chunks are dropped when exceeding MAX_HISTORY
// droppedCount tracks how many chunks were trimmed so ?from=N offsets stay valid
const stdoutHistory: string[] = [];
let stdoutDropped = 0;
const stderrHistory: string[] = [];
let stderrDropped = 0;
const combinedHistory: { type: "stdout" | "stderr"; data: string }[] = [];
let combinedDropped = 0;

function trimHistory<T>(history: T[], dropped: number): number {
  if (history.length > MAX_HISTORY) {
    const excess = history.length - MAX_HISTORY;
    history.splice(0, excess);
    return dropped + excess;
  }
  return dropped;
}

// Active SSE client connections per stream
const stdoutClients = new Set<ReadableStreamDefaultController>();
const stderrClients = new Set<ReadableStreamDefaultController>();
const combinedClients = new Set<ReadableStreamDefaultController>();

let activeConnectionCount = 0;
const textEncoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;
let heartbeatTimer: Timer | null = null;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const ping = textEncoder.encode(": ping\n\n");
    for (const client of stdoutClients) { try { client.enqueue(ping); } catch { dropClient(client, stdoutClients); } }
    for (const client of stderrClients) { try { client.enqueue(ping); } catch { dropClient(client, stderrClients); } }
    for (const client of combinedClients) { try { client.enqueue(ping); } catch { dropClient(client, combinedClients); } }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// --- SSE helpers ---

function encodeSSE(data: string, eventType?: string, id?: number): Uint8Array {
  const base64 = btoa(unescape(encodeURIComponent(data)));
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  const eventLine = eventType ? `event: ${eventType}\n` : "";
  return textEncoder.encode(`${idLine}${eventLine}data: ${base64}\n\n`);
}

function sendToClient(client: ReadableStreamDefaultController, data: string, eventType?: string, id?: number) {
  try { client.enqueue(encodeSSE(data, eventType, id)); } catch { /* client disconnected */ }
}

function dropClient(client: ReadableStreamDefaultController, clients: Set<ReadableStreamDefaultController>) {
  if (clients.delete(client)) {
    activeConnectionCount--;
    try { client.close(); } catch { /* already closed */ }
    if (activeConnectionCount === 0) stopHeartbeat();
    shutdownIfIdle();
  }
}

function broadcastToClients(clients: Set<ReadableStreamDefaultController>, data: string, eventType?: string, id?: number) {
  if (!clients.size) return;
  const encoded = encodeSSE(data, eventType, id);
  for (const client of clients) {
    try {
      client.enqueue(encoded);
    } catch {
      dropClient(client, clients);
    }
  }
}

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

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

// --- Spawn the child process ---

let spawnError: string | null = null;
let proc: ReturnType<typeof spawn> | null = null;
let ptyProc: any = null;

function writeStdin(text: string) {
  if (PTY_MODE && ptyProc) {
    ptyProc.write(text + "\n");
  } else if (proc) {
    try { proc.stdin.write(text + "\n"); proc.stdin.flush(); } catch { /* closed */ }
  }
}

function killChild() {
  if (PTY_MODE && ptyProc) {
    ptyProc.kill();
  } else if (proc) {
    proc.kill();
  }
}

if (PTY_MODE) {
  try {
    const nodePty = require("node-pty");
    ptyProc = nodePty.spawn(command[0], command.slice(1), {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
    console.error(`Failed to spawn PTY process: ${spawnError}`);
    processExited = true;
    processExitCode = 127;
  }
} else {
  try {
    proc = spawn({ cmd: command, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
    console.error(`Failed to spawn process: ${spawnError}`);
    processExited = true;
    processExitCode = 127;
  }
}

// --- HTTP server ---

function parseReplayOffset(req: Request, url: URL): number {
  const lastEventId = req.headers.get("Last-Event-ID");
  if (lastEventId) return parseInt(lastEventId, 10) + 1 || 0;
  return Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0);
}

const exitMessage = () => `\r\n[Process exited with code ${processExitCode}]\r\n`;

function checkAuth(req: Request, url: URL): boolean {
  if (!AUTH_TOKEN) return true;
  const bearer = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearer === AUTH_TOKEN) return true;
  if (url.searchParams.get("token") === AUTH_TOKEN) return true;
  return false;
}

const UNAUTHORIZED = () => new Response("Unauthorized", { status: 401 });

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html") {
      const hasControl = checkAuth(req, url);
      const html = HTML.replace('__HAS_CONTROL__', String(hasControl));
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (pathname === "/status") {
      return Response.json({ running: !processExited, exitCode: processExitCode, spawnError });
    }

    if (pathname === "/kill" && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      if (!processExited) killChild();
      return Response.json({ ok: true });
    }

    if (pathname === "/stdin" && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      if (!processExited) {
        const text = await req.text();
        writeStdin(text);
      }
      return Response.json({ ok: true });
    }

    if (pathname === "/stdout") {
      const from = parseReplayOffset(req, url);
      return new Response(createSSEStream(stdoutClients, client => {
        const idx = Math.max(0, from - stdoutDropped);
        for (let i = idx; i < stdoutHistory.length; i++) sendToClient(client, stdoutHistory[i], undefined, stdoutDropped + i);
        if (processExited) sendToClient(client, exitMessage());
      }), { headers: SSE_HEADERS });
    }

    if (pathname === "/stderr") {
      const from = parseReplayOffset(req, url);
      return new Response(createSSEStream(stderrClients, client => {
        const idx = Math.max(0, from - stderrDropped);
        for (let i = idx; i < stderrHistory.length; i++) sendToClient(client, stderrHistory[i], undefined, stderrDropped + i);
        if (processExited) sendToClient(client, exitMessage());
      }), { headers: SSE_HEADERS });
    }

    if (pathname === "/combined") {
      const from = parseReplayOffset(req, url);
      return new Response(createSSEStream(combinedClients, client => {
        const idx = Math.max(0, from - combinedDropped);
        for (let i = idx; i < combinedHistory.length; i++) {
          const { type, data } = combinedHistory[i];
          sendToClient(client, data, type, combinedDropped + i);
        }
        if (processExited) sendToClient(client, exitMessage());
      }), { headers: SSE_HEADERS });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// --- Pipe process output to SSE clients ---

function handleStdoutData(data: string) {
  stdoutHistory.push(data);
  stdoutDropped = trimHistory(stdoutHistory, stdoutDropped);
  const stdoutEventId = stdoutDropped + stdoutHistory.length - 1;
  broadcastToClients(stdoutClients, data, undefined, stdoutEventId);
  combinedHistory.push({ type: "stdout", data });
  combinedDropped = trimHistory(combinedHistory, combinedDropped);
  const combinedEventId = combinedDropped + combinedHistory.length - 1;
  broadcastToClients(combinedClients, data, "stdout", combinedEventId);
  appendLog(stdoutLogPath, data);
  appendLog(combinedLogPath, data);
}

function handleStderrData(data: string) {
  stderrHistory.push(data);
  stderrDropped = trimHistory(stderrHistory, stderrDropped);
  const stderrEventId = stderrDropped + stderrHistory.length - 1;
  broadcastToClients(stderrClients, data, undefined, stderrEventId);
  combinedHistory.push({ type: "stderr", data });
  combinedDropped = trimHistory(combinedHistory, combinedDropped);
  const combinedEventId = combinedDropped + combinedHistory.length - 1;
  broadcastToClients(combinedClients, data, "stderr", combinedEventId);
  appendLog(stderrLogPath, data);
  appendLog(combinedLogPath, data);
}

function handleProcessExit(code: number) {
  processExitCode = code;
  processExited = true;
  const message = exitMessage();
  broadcastToClients(stdoutClients, message);
  broadcastToClients(stderrClients, message);
  broadcastToClients(combinedClients, message);
  console.log(`\nProcess exited with code ${code}`);
  updateMetadata(code);
  shutdownIfIdle();
}

if (!spawnError && PTY_MODE && ptyProc) {
  // PTY mode: single output stream, no separate stderr
  ptyProc.onData((data: string) => {
    handleStdoutData(data);
  });
  ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
    handleProcessExit(exitCode);
  });
} else if (!spawnError && proc) {
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  proc.stdout.pipeTo(new WritableStream({
    write(chunk) {
      handleStdoutData(stdoutDecoder.decode(chunk, { stream: true }));
    },
    close() {
      const remaining = stdoutDecoder.decode();
      if (remaining) handleStdoutData(remaining);
    },
  })).catch(err => {
    console.error("stdout pipe error:", err.message);
  });

  proc.stderr.pipeTo(new WritableStream({
    write(chunk) {
      handleStderrData(stderrDecoder.decode(chunk, { stream: true }));
    },
    close() {
      const remaining = stderrDecoder.decode();
      if (remaining) handleStderrData(remaining);
    },
  })).catch(err => {
    console.error("stderr pipe error:", err.message);
  });

  proc.exited.then((code) => {
    handleProcessExit(code);
  }).catch(err => {
    console.error("Process exited with error:", err.message);
    processExitCode = 1;
    processExited = true;
    const message = `\r\n[Process failed: ${err.message}]\r\n`;
    broadcastToClients(stdoutClients, message);
    broadcastToClients(stderrClients, message);
    broadcastToClients(combinedClients, message);
    updateMetadata(1);
    shutdownIfIdle();
  });
} else if (spawnError) {
  broadcastToClients(stdoutClients, `\r\n[Failed to start process: ${spawnError}]\r\n`);
  broadcastToClients(stderrClients, `\r\n[Failed to start process: ${spawnError}]\r\n`);
  broadcastToClients(combinedClients, `\r\n[Failed to start process: ${spawnError}]\r\n`);
}

let shutdownTimer: Timer | null = null;
let hasShutdown = false;

function shutdown(reason: string) {
  if (hasShutdown) return;
  hasShutdown = true;
  console.log(`\n${reason}`);
  stopHeartbeat();
  if (!processExited) {
    try { killChild(); } catch { /* already dead */ }
  }
  server.stop();
}

function cancelPendingShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

function shutdownIfIdle() {
  if (!processExited || activeConnectionCount > 0) {
    cancelPendingShutdown();
    return;
  }
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    if (activeConnectionCount === 0) {
      shutdown("All clients disconnected, shutting down...");
    }
  }, 5000);
}

setTimeout(() => {
  if (activeConnectionCount === 0) {
    shutdown("No clients connected, shutting down...");
  }
}, 60000);

// Forward signals to child process and clean up
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdown(`Received ${sig}, shutting down...`);
    process.exit(0);
  });
}

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
    const AUTH_TOKEN = ${AUTH_TOKEN ? `'${AUTH_TOKEN}'` : 'null'};
    const HAS_CONTROL = __HAS_CONTROL__;
    function authHeaders() { return AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {}; }

    // Hide control elements in read-only mode
    if (!HAS_CONTROL) {
      document.getElementById('kill-btn').style.display = 'none';
      document.getElementById('stdin-area').style.display = 'none';
    }

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
        if (s.spawnError) {
          processExited = true;
          el.textContent = '\\u25cf Spawn Error';
          el.className = 'status-exited';
          document.getElementById('kill-btn').style.display = 'none';
          document.getElementById('stdin-area').style.display = 'none';
          clearInterval(statusTimer);
        } else if (s.running) {
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
      fetch('/kill', { method: 'POST', headers: authHeaders() }).catch(() => {});
    }

    // --- Stdin ---
    function sendStdin() {
      const inp = document.getElementById('stdin-input');
      const text = inp.value;
      if (!text) return;
      fetch('/stdin', { method: 'POST', body: text, headers: authHeaders() }).catch(() => {});
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

    // Track last event ID for reconnect resume
    let stdoutLastId = -1, stderrLastId = -1, combinedLastId = -1;

    connectSSE(() => '/stdout' + (stdoutLastId >= 0 ? '?from=' + (stdoutLastId + 1) : ''), source => {
      source.onmessage = e => { if (e.lastEventId) stdoutLastId = parseInt(e.lastEventId); writeToTerminal(panels.stdout.terminal, decodeBase64(e.data)); };
    });

    connectSSE(() => '/stderr' + (stderrLastId >= 0 ? '?from=' + (stderrLastId + 1) : ''), source => {
      source.onmessage = e => { if (e.lastEventId) stderrLastId = parseInt(e.lastEventId); writeToTerminal(panels.stderr.terminal, decodeBase64(e.data)); };
    });

    connectSSE(() => '/combined' + (combinedLastId >= 0 ? '?from=' + (combinedLastId + 1) : ''), source => {
      source.addEventListener('stdout', e => {
        if (e.lastEventId) combinedLastId = parseInt(e.lastEventId);
        writeToTerminal(panels.combined.terminal, decodeBase64(e.data));
      });
      source.addEventListener('stderr', e => {
        if (e.lastEventId) combinedLastId = parseInt(e.lastEventId);
        writeToTerminal(panels.combined.terminal, '\\x1b[31m' + decodeBase64(e.data) + '\\x1b[0m');
      });
      source.onmessage = e => writeToTerminal(panels.combined.terminal, decodeBase64(e.data));
    });
  </script>
</body>
</html>`;
