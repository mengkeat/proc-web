import { spawn } from "bun";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// --- CLI argument parsing ---

function parseArgs(argv: string[]): { port: number; host: string; maxHistory: number; logDir: string | null; token: string | null; pty: boolean; command: string[] } {
  const args = argv.slice(2);
  let port = 3000;
  let host = "127.0.0.1";
  let maxHistory = 10000;
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

const { port: PORT, host: HOST, maxHistory: MAX_HISTORY, logDir: LOG_DIR, token: AUTH_TOKEN, pty: PTY_MODE, command: INITIAL_COMMAND } = parseArgs(Bun.argv);

// --- Types ---

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

// --- Session class ---

class Session {
  id: string;
  command: string[];
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  spawnError: string | null;
  processExited: boolean;
  pty: boolean;

  stdoutHistory: string[];
  stdoutDropped: number;
  stderrHistory: string[];
  stderrDropped: number;
  combinedHistory: { type: "stdout" | "stderr"; data: string }[];
  combinedDropped: number;

  stdoutClients: Set<ReadableStreamDefaultController>;
  stderrClients: Set<ReadableStreamDefaultController>;
  combinedClients: Set<ReadableStreamDefaultController>;
  activeConnectionCount: number;
  heartbeatTimer: Timer | null;

  proc: ReturnType<typeof spawn> | null;
  ptyProc: any;

  logSessionDir: string | null;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  combinedLogPath: string | null;
  metadataPath: string | null;

  private maxHistory: number;
  private textEncoder: TextEncoder;
  private onStateChange: () => void;

  constructor(command: string[], pty: boolean, logDir: string | null, maxHistory: number, onStateChange: () => void) {
    this.id = randomUUID();
    this.command = command;
    this.startTime = Date.now();
    this.endTime = null;
    this.exitCode = null;
    this.spawnError = null;
    this.processExited = false;
    this.pty = pty;

    this.stdoutHistory = [];
    this.stdoutDropped = 0;
    this.stderrHistory = [];
    this.stderrDropped = 0;
    this.combinedHistory = [];
    this.combinedDropped = 0;

    this.stdoutClients = new Set();
    this.stderrClients = new Set();
    this.combinedClients = new Set();
    this.activeConnectionCount = 0;
    this.heartbeatTimer = null;

    this.proc = null;
    this.ptyProc = null;

    this.logSessionDir = null;
    this.stdoutLogPath = null;
    this.stderrLogPath = null;
    this.combinedLogPath = null;
    this.metadataPath = null;

    this.maxHistory = maxHistory;
    this.textEncoder = new TextEncoder();
    this.onStateChange = onStateChange;

    if (logDir) {
      this.logSessionDir = join(logDir, this.id);
      mkdirSync(this.logSessionDir, { recursive: true });
      this.stdoutLogPath = join(this.logSessionDir, "stdout.log");
      this.stderrLogPath = join(this.logSessionDir, "stderr.log");
      this.combinedLogPath = join(this.logSessionDir, "combined.log");
      this.metadataPath = join(this.logSessionDir, "metadata.json");
      writeFileSync(this.metadataPath, JSON.stringify({
        id: this.id,
        command,
        startTime: new Date(this.startTime).toISOString(),
        pid: process.pid,
      }, null, 2));
    }

    this.spawnProcess();
  }

  getMetadata(): SessionMetadata {
    return {
      id: this.id,
      command: this.command,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.endTime ? this.endTime - this.startTime : null,
      exitCode: this.exitCode,
      spawnError: this.spawnError,
      processExited: this.processExited,
      pty: this.pty,
    };
  }

  private appendLog(path: string | null, data: string) {
    if (path) try { appendFileSync(path, data); } catch { /* ignore */ }
  }

  private updateMetadata() {
    if (this.metadataPath) {
      try {
        writeFileSync(this.metadataPath, JSON.stringify({
          id: this.id,
          command: this.command,
          startTime: new Date(this.startTime).toISOString(),
          endTime: this.endTime ? new Date(this.endTime).toISOString() : null,
          durationMs: this.endTime ? this.endTime - this.startTime : null,
          exitCode: this.exitCode,
          pid: process.pid,
        }, null, 2));
      } catch { /* ignore */ }
    }
  }

  private trimHistory<T>(history: T[], dropped: number): number {
    if (history.length > this.maxHistory) {
      const excess = history.length - this.maxHistory;
      history.splice(0, excess);
      return dropped + excess;
    }
    return dropped;
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const ping = this.textEncoder.encode(": ping\n\n");
      for (const client of this.stdoutClients) { try { client.enqueue(ping); } catch { this.dropClient(client, this.stdoutClients); } }
      for (const client of this.stderrClients) { try { client.enqueue(ping); } catch { this.dropClient(client, this.stderrClients); } }
      for (const client of this.combinedClients) { try { client.enqueue(ping); } catch { this.dropClient(client, this.combinedClients); } }
    }, 15_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private encodeSSE(data: string, eventType?: string, id?: number): Uint8Array {
    const base64 = btoa(unescape(encodeURIComponent(data)));
    const idLine = id !== undefined ? `id: ${id}\n` : "";
    const eventLine = eventType ? `event: ${eventType}\n` : "";
    return this.textEncoder.encode(`${idLine}${eventLine}data: ${base64}\n\n`);
  }

  private sendToClient(client: ReadableStreamDefaultController, data: string, eventType?: string, id?: number) {
    try { client.enqueue(this.encodeSSE(data, eventType, id)); } catch { /* disconnected */ }
  }

  private dropClient(client: ReadableStreamDefaultController, clients: Set<ReadableStreamDefaultController>) {
    if (clients.delete(client)) {
      this.activeConnectionCount--;
      try { client.close(); } catch { /* already closed */ }
      if (this.activeConnectionCount === 0) this.stopHeartbeat();
    }
  }

  private broadcast(clients: Set<ReadableStreamDefaultController>, data: string, eventType?: string, id?: number) {
    if (!clients.size) return;
    const encoded = this.encodeSSE(data, eventType, id);
    for (const client of clients) {
      try {
        client.enqueue(encoded);
      } catch {
        this.dropClient(client, clients);
      }
    }
  }

  createSSEStream(
    clients: Set<ReadableStreamDefaultController>,
    replayHistory: (client: ReadableStreamDefaultController) => void
  ): ReadableStream {
    this.activeConnectionCount++;
    if (this.activeConnectionCount === 1) this.startHeartbeat();
    let thisClient!: ReadableStreamDefaultController;
    return new ReadableStream({
      start(controller) {
        thisClient = controller;
        clients.add(controller);
        replayHistory(controller);
      },
      cancel: () => {
        this.activeConnectionCount--;
        clients.delete(thisClient);
        if (this.activeConnectionCount === 0) this.stopHeartbeat();
      },
    });
  }

  private exitMessage(): string {
    return `\r\n[Process exited with code ${this.exitCode}]\r\n`;
  }

  private handleStdoutData(data: string) {
    this.stdoutHistory.push(data);
    this.stdoutDropped = this.trimHistory(this.stdoutHistory, this.stdoutDropped);
    const stdoutEventId = this.stdoutDropped + this.stdoutHistory.length - 1;
    this.broadcast(this.stdoutClients, data, undefined, stdoutEventId);
    this.combinedHistory.push({ type: "stdout", data });
    this.combinedDropped = this.trimHistory(this.combinedHistory, this.combinedDropped);
    const combinedEventId = this.combinedDropped + this.combinedHistory.length - 1;
    this.broadcast(this.combinedClients, data, "stdout", combinedEventId);
    this.appendLog(this.stdoutLogPath, data);
    this.appendLog(this.combinedLogPath, data);
  }

  private handleStderrData(data: string) {
    this.stderrHistory.push(data);
    this.stderrDropped = this.trimHistory(this.stderrHistory, this.stderrDropped);
    const stderrEventId = this.stderrDropped + this.stderrHistory.length - 1;
    this.broadcast(this.stderrClients, data, undefined, stderrEventId);
    this.combinedHistory.push({ type: "stderr", data });
    this.combinedDropped = this.trimHistory(this.combinedHistory, this.combinedDropped);
    const combinedEventId = this.combinedDropped + this.combinedHistory.length - 1;
    this.broadcast(this.combinedClients, data, "stderr", combinedEventId);
    this.appendLog(this.stderrLogPath, data);
    this.appendLog(this.combinedLogPath, data);
  }

  private handleProcessExit(code: number) {
    this.exitCode = code;
    this.processExited = true;
    this.endTime = Date.now();
    const message = this.exitMessage();
    this.broadcast(this.stdoutClients, message);
    this.broadcast(this.stderrClients, message);
    this.broadcast(this.combinedClients, message);
    console.log(`\n[${this.id.slice(0, 8)}] Process exited with code ${code}`);
    this.updateMetadata();
    this.onStateChange();
  }

  private spawnProcess() {
    if (this.pty) {
      try {
        const nodePty = require("node-pty");
        this.ptyProc = nodePty.spawn(this.command[0], this.command.slice(1), {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: process.env,
        });
      } catch (err) {
        this.spawnError = err instanceof Error ? err.message : String(err);
        console.error(`[${this.id.slice(0, 8)}] Failed to spawn PTY process: ${this.spawnError}`);
        this.processExited = true;
        this.exitCode = 127;
        this.endTime = Date.now();
        this.updateMetadata();
        this.onStateChange();
        this.broadcast(this.stdoutClients, `\r\n[Failed to start PTY process: ${this.spawnError}]\r\n`);
        this.broadcast(this.stderrClients, `\r\n[Failed to start PTY process: ${this.spawnError}]\r\n`);
        this.broadcast(this.combinedClients, `\r\n[Failed to start PTY process: ${this.spawnError}]\r\n`);
        return;
      }
    } else {
      try {
        this.proc = spawn({ cmd: this.command, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
      } catch (err) {
        this.spawnError = err instanceof Error ? err.message : String(err);
        console.error(`[${this.id.slice(0, 8)}] Failed to spawn process: ${this.spawnError}`);
        this.processExited = true;
        this.exitCode = 127;
        this.endTime = Date.now();
        this.updateMetadata();
        this.onStateChange();
        this.broadcast(this.stdoutClients, `\r\n[Failed to start process: ${this.spawnError}]\r\n`);
        this.broadcast(this.stderrClients, `\r\n[Failed to start process: ${this.spawnError}]\r\n`);
        this.broadcast(this.combinedClients, `\r\n[Failed to start process: ${this.spawnError}]\r\n`);
        return;
      }
    }

    if (this.pty && this.ptyProc) {
      this.ptyProc.onData((data: string) => {
        this.handleStdoutData(data);
      });
      this.ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
        this.handleProcessExit(exitCode);
      });
    } else if (this.proc) {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();

      this.proc.stdout.pipeTo(new WritableStream({
        write: (chunk) => {
          this.handleStdoutData(stdoutDecoder.decode(chunk, { stream: true }));
        },
        close: () => {
          const remaining = stdoutDecoder.decode();
          if (remaining) this.handleStdoutData(remaining);
        },
      })).catch(err => {
        console.error(`[${this.id.slice(0, 8)}] stdout pipe error:`, err.message);
      });

      this.proc.stderr.pipeTo(new WritableStream({
        write: (chunk) => {
          this.handleStderrData(stderrDecoder.decode(chunk, { stream: true }));
        },
        close: () => {
          const remaining = stderrDecoder.decode();
          if (remaining) this.handleStderrData(remaining);
        },
      })).catch(err => {
        console.error(`[${this.id.slice(0, 8)}] stderr pipe error:`, err.message);
      });

      this.proc.exited.then((code) => {
        this.handleProcessExit(code);
      }).catch(err => {
        console.error(`[${this.id.slice(0, 8)}] Process exited with error:`, err.message);
        this.exitCode = 1;
        this.processExited = true;
        this.endTime = Date.now();
        const message = `\r\n[Process failed: ${err.message}]\r\n`;
        this.broadcast(this.stdoutClients, message);
        this.broadcast(this.stderrClients, message);
        this.broadcast(this.combinedClients, message);
        this.updateMetadata();
        this.onStateChange();
      });
    }
  }

  writeStdin(text: string, raw = false) {
    const data = raw ? text : text + "\n";
    if (this.pty && this.ptyProc) {
      this.ptyProc.write(data);
    } else if (this.proc) {
      try { this.proc.stdin.write(data); this.proc.stdin.flush(); } catch { /* closed */ }
    }
  }

  kill() {
    if (this.pty && this.ptyProc) {
      this.ptyProc.kill();
    } else if (this.proc) {
      this.proc.kill();
    }
  }

  sendSignal(signal: string) {
    if (this.processExited) return;
    const sigMap: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
    const sigNum = sigMap[signal];
    if (sigNum !== undefined) {
      if (this.pty && this.ptyProc) {
        try { this.ptyProc.kill(sigNum); } catch { /* ignore */ }
      } else if (this.proc) {
        try { this.proc.kill(sigNum); } catch { /* ignore */ }
      }
    }
  }

  resize(cols: number, rows: number) {
    if (this.pty && this.ptyProc && !this.processExited) {
      if (cols > 0 && rows > 0) {
        try { this.ptyProc.resize(cols, rows); } catch { /* ignore */ }
      }
    }
  }

  getStatus() {
    return {
      running: !this.processExited,
      exitCode: this.exitCode,
      spawnError: this.spawnError,
      startTime: this.startTime,
      viewerCount: this.activeConnectionCount,
    };
  }

  cleanup() {
    this.stopHeartbeat();
    if (!this.processExited) {
      try { this.kill(); } catch { /* already dead */ }
    }
  }
}

// --- Session manager ---

class SessionManager {
  sessions: Map<string, Session>;
  completedMeta: Map<string, SessionMetadata>;
  private logDir: string | null;
  private maxHistory: number;
  private pty: boolean;
  private onStateChange: () => void;

  constructor(logDir: string | null, maxHistory: number, pty: boolean, onStateChange: () => void) {
    this.sessions = new Map();
    this.completedMeta = new Map();
    this.logDir = logDir;
    this.maxHistory = maxHistory;
    this.pty = pty;
    this.onStateChange = onStateChange;
  }

  createSession(command: string[]): Session {
    const session = new Session(command, this.pty, this.logDir, this.maxHistory, () => {
      this.onSessionComplete(session);
    });
    this.sessions.set(session.id, session);
    console.log(`[${session.id.slice(0, 8)}] New session: ${command.join(" ")}`);
    this.onStateChange();
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getSessionMetadata(id: string): SessionMetadata | null {
    const session = this.sessions.get(id);
    if (session) return session.getMetadata();
    const meta = this.completedMeta.get(id);
    return meta ?? null;
  }

  listSessions(): SessionMetadata[] {
    const results: SessionMetadata[] = [];
    for (const session of this.sessions.values()) {
      results.push(session.getMetadata());
    }
    for (const meta of this.completedMeta.values()) {
      if (!this.sessions.has(meta.id)) {
        results.push(meta);
      }
    }
    return results;
  }

  private onSessionComplete(session: Session) {
    this.completedMeta.set(session.id, session.getMetadata());
    this.onStateChange();
  }

  loadCompletedSessions() {
    if (!this.logDir || !existsSync(this.logDir)) return;
    try {
      const entries = readdirSync(this.logDir);
      for (const entry of entries) {
        const metaPath = join(this.logDir, entry, "metadata.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            const sessionMeta: SessionMetadata = {
              id: meta.id || entry,
              command: meta.command || [],
              startTime: meta.startTime ? new Date(meta.startTime).getTime() : 0,
              endTime: meta.endTime ? new Date(meta.endTime).getTime() : null,
              durationMs: meta.durationMs || null,
              exitCode: meta.exitCode ?? null,
              spawnError: meta.spawnError || null,
              processExited: true,
              pty: meta.pty || false,
            };
            this.completedMeta.set(sessionMeta.id, sessionMeta);
          } catch { /* skip malformed */ }
        }
      }
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

console.log(`Starting: ${INITIAL_COMMAND.join(" ")}`);
console.log(`Open http://localhost:${PORT} in your browser`);
for (const ip of getLocalNetworkIPs()) {
  console.log(`      http://${ip}:${PORT}`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Session manager instance ---

const sessionManager = new SessionManager(LOG_DIR, MAX_HISTORY, PTY_MODE, () => {});

// Load any previously completed sessions from disk
sessionManager.loadCompletedSessions();

// Create the initial session from CLI command
const initialSession = sessionManager.createSession(INITIAL_COMMAND);

// --- HTTP server ---

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function checkAuth(req: Request, url: URL): boolean {
  if (!AUTH_TOKEN) return true;
  const bearer = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearer === AUTH_TOKEN) return true;
  if (url.searchParams.get("token") === AUTH_TOKEN) return true;
  return false;
}

const UNAUTHORIZED = () => new Response("Unauthorized", { status: 401 });

function parseReplayOffset(req: Request, url: URL): number {
  const lastEventId = req.headers.get("Last-Event-ID");
  if (lastEventId) return parseInt(lastEventId, 10) + 1 || 0;
  return Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0);
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Session list page
    if (pathname === "/" || pathname === "/index.html") {
      const hasControl = checkAuth(req, url);
      const html = generateSessionListHTML(sessionManager.listSessions(), AUTH_TOKEN, hasControl);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // API: list sessions
    if (pathname === "/api/sessions" && req.method === "GET") {
      return Response.json(sessionManager.listSessions());
    }

    // API: create session
    if (pathname === "/api/sessions" && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      try {
        const body = await req.json();
        if (!body.command || !Array.isArray(body.command) || body.command.length === 0) {
          return Response.json({ error: "command is required and must be a non-empty array" }, { status: 400 });
        }
        const session = sessionManager.createSession(body.command);
        return Response.json(session.getMetadata(), { status: 201 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    // Session view page
    const sessionViewMatch = pathname.match(/^\/sessions\/([^\/]+)$/);
    if (sessionViewMatch) {
      const sessionId = sessionViewMatch[1];
      const session = sessionManager.getSession(sessionId);
      if (session) {
        const hasControl = checkAuth(req, url);
        const html = generateSessionHTML(session, AUTH_TOKEN, hasControl);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      const meta = sessionManager.getSessionMetadata(sessionId);
      if (meta) {
        const hasControl = checkAuth(req, url);
        const html = generateCompletedSessionHTML(meta, AUTH_TOKEN, hasControl);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      return new Response("Session not found", { status: 404 });
    }

    // Session SSE streams
    const sessionSseMatch = pathname.match(/^\/sessions\/([^\/]+)\/(stdout|stderr|combined)$/);
    if (sessionSseMatch) {
      const sessionId = sessionSseMatch[1];
      const streamType = sessionSseMatch[2] as "stdout" | "stderr" | "combined";
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }
      const from = parseReplayOffset(req, url);
      const exitMessage = () => `\r\n[Process exited with code ${session.exitCode}]\r\n`;

      if (streamType === "stdout") {
        return new Response(session.createSSEStream(session.stdoutClients, client => {
          const idx = Math.max(0, from - session.stdoutDropped);
          for (let i = idx; i < session.stdoutHistory.length; i++) session.sendToClient(client, session.stdoutHistory[i], undefined, session.stdoutDropped + i);
          if (session.processExited) session.sendToClient(client, exitMessage());
        }), { headers: SSE_HEADERS });
      }

      if (streamType === "stderr") {
        return new Response(session.createSSEStream(session.stderrClients, client => {
          const idx = Math.max(0, from - session.stderrDropped);
          for (let i = idx; i < session.stderrHistory.length; i++) session.sendToClient(client, session.stderrHistory[i], undefined, session.stderrDropped + i);
          if (session.processExited) session.sendToClient(client, exitMessage());
        }), { headers: SSE_HEADERS });
      }

      if (streamType === "combined") {
        return new Response(session.createSSEStream(session.combinedClients, client => {
          const idx = Math.max(0, from - session.combinedDropped);
          for (let i = idx; i < session.combinedHistory.length; i++) {
            const { type, data } = session.combinedHistory[i];
            session.sendToClient(client, data, type, session.combinedDropped + i);
          }
          if (session.processExited) session.sendToClient(client, exitMessage());
        }), { headers: SSE_HEADERS });
      }
    }

    // Session status
    const sessionStatusMatch = pathname.match(/^\/sessions\/([^\/]+)\/status$/);
    if (sessionStatusMatch) {
      const sessionId = sessionStatusMatch[1];
      const session = sessionManager.getSession(sessionId);
      if (session) return Response.json(session.getStatus());
      const meta = sessionManager.getSessionMetadata(sessionId);
      if (meta) {
        return Response.json({
          running: !meta.processExited,
          exitCode: meta.exitCode,
          spawnError: meta.spawnError,
        });
      }
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Session kill
    const sessionKillMatch = pathname.match(/^\/sessions\/([^\/]+)\/kill$/);
    if (sessionKillMatch && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      const sessionId = sessionKillMatch[1];
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (!session.processExited) session.kill();
      return Response.json({ ok: true });
    }

    // Session rerun
    const sessionRerunMatch = pathname.match(/^\/sessions\/([^\/]+)\/rerun$/);
    if (sessionRerunMatch && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      const sessionId = sessionRerunMatch[1];
      const meta = sessionManager.getSessionMetadata(sessionId);
      if (!meta) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      const newSession = sessionManager.createSession(meta.command);
      return Response.json(newSession.getMetadata(), { status: 201 });
    }

    // Session log export
    const sessionExportMatch = pathname.match(/^\/sessions\/([^\/]+)\/export\/(stdout|stderr|combined|metadata)$/);
    if (sessionExportMatch && req.method === "GET") {
      const sessionId = sessionExportMatch[1];
      const exportType = sessionExportMatch[2] as "stdout" | "stderr" | "combined" | "metadata";

      // Try active session first
      const session = sessionManager.getSession(sessionId);
      if (session) {
        if (exportType === "metadata") {
          return Response.json(session.getMetadata(), {
            headers: { "Content-Disposition": `attachment; filename="${sessionId}-metadata.json"` },
          });
        }
        const history = exportType === "stdout" ? session.stdoutHistory :
                        exportType === "stderr" ? session.stderrHistory :
                        session.combinedHistory.map(e => e.data);
        const content = history.join("");
        return new Response(content, {
          headers: {
            "Content-Type": "text/plain",
            "Content-Disposition": `attachment; filename="${sessionId}-${exportType}.log"`,
          },
        });
      }

      // Try completed session from disk
      const meta = sessionManager.getSessionMetadata(sessionId);
      if (!meta) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (LOG_DIR) {
        const logDir = join(LOG_DIR, sessionId);
        if (exportType === "metadata") {
          const metaPath = join(logDir, "metadata.json");
          if (existsSync(metaPath)) {
            const content = readFileSync(metaPath, "utf-8");
            return new Response(content, {
              headers: {
                "Content-Type": "application/json",
                "Content-Disposition": `attachment; filename="${sessionId}-metadata.json"`,
              },
            });
          }
        } else {
          const logFile = join(logDir, `${exportType}.log`);
          if (existsSync(logFile)) {
            const content = readFileSync(logFile, "utf-8");
            return new Response(content, {
              headers: {
                "Content-Type": "text/plain",
                "Content-Disposition": `attachment; filename="${sessionId}-${exportType}.log"`,
              },
            });
          }
        }
      }
      return Response.json({ error: "Log files not available for this session" }, { status: 404 });
    }

    // Session stdin
    const sessionStdinMatch = pathname.match(/^\/sessions\/([^\/]+)\/stdin$/);
    if (sessionStdinMatch && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      const sessionId = sessionStdinMatch[1];
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (!session.processExited) {
        const text = await req.text();
        const raw = url.searchParams.get("raw") === "1";
        session.writeStdin(text, raw);
      }
      return Response.json({ ok: true });
    }

    // Session signal
    const sessionSignalMatch = pathname.match(/^\/sessions\/([^\/]+)\/signal$/);
    if (sessionSignalMatch && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      const sessionId = sessionSignalMatch[1];
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (!session.processExited) {
        const { signal } = await req.json();
        session.sendSignal(signal);
      }
      return Response.json({ ok: true });
    }

    // Session resize
    const sessionResizeMatch = pathname.match(/^\/sessions\/([^\/]+)\/resize$/);
    if (sessionResizeMatch && req.method === "POST") {
      if (!checkAuth(req, url)) return UNAUTHORIZED();
      const sessionId = sessionResizeMatch[1];
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (!session.processExited) {
        const { cols, rows } = await req.json();
        session.resize(cols, rows);
      }
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// --- Signal handling ---

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\nReceived ${sig}, shutting down...`);
    for (const session of sessionManager.sessions.values()) {
      session.cleanup();
    }
    server.stop();
    process.exit(0);
  });
}

// --- HTML templates ---

function generateSessionListHTML(sessions: SessionMetadata[], authToken: string | null, hasControl: boolean): string {
  const rows = sessions.map(s => {
    const statusClass = s.processExited ? (s.exitCode === 0 ? "status-exited-ok" : "status-exited-err") : "status-running";
    const statusText = s.processExited ? `Exited (${s.exitCode})` : "Running";
    const startTime = new Date(s.startTime).toLocaleTimeString();
    const duration = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "—";
    const cmd = escapeHtml(s.command.join(" "));
    const shortId = s.id.slice(0, 8);
    const actions = hasControl ? `<button class="btn" onclick="rerunSession('${s.id}')">Rerun</button>` : "";
    return `<tr>
      <td><a href="/sessions/${s.id}" class="session-link">${shortId}</a></td>
      <td class="cmd-cell" title="${cmd}">${cmd}</td>
      <td><span class="${statusClass}">${statusText}</span></td>
      <td>${startTime}</td>
      <td>${duration}</td>
      ${hasControl ? `<td>${actions}</td>` : ""}
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>proc-web: Sessions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
      min-height: 100vh;
      padding: 24px;
    }
    h1 { color: #4ec9b0; font-size: 20px; margin-bottom: 16px; }
    .new-session {
      background: #2d2d2d;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .new-session input {
      flex: 1;
      background: #1e1e1e;
      border: 1px solid #4a4a4a;
      color: #d4d4d4;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: Monaco, Menlo, 'Courier New', monospace;
      font-size: 13px;
    }
    .new-session input:focus { outline: none; border-color: #4ec9b0; }
    .btn {
      background: #3c3c3c;
      color: #d4d4d4;
      border: 1px solid #555;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .btn:hover { background: #4a4a4a; }
    .btn-primary { background: #4ec9b0; color: #1e1e1e; border-color: #4ec9b0; font-weight: 600; }
    .btn-primary:hover { background: #3db89e; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #2d2d2d;
      border-radius: 6px;
      overflow: hidden;
    }
    th {
      background: #252526;
      text-align: left;
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td {
      padding: 10px 14px;
      border-top: 1px solid #3d3d3d;
      font-size: 13px;
    }
    .session-link {
      color: #4ec9b0;
      text-decoration: none;
      font-family: Monaco, Menlo, monospace;
    }
    .session-link:hover { text-decoration: underline; }
    .cmd-cell {
      font-family: Monaco, Menlo, monospace;
      font-size: 12px;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-running { color: #4ec9b0; }
    .status-exited-ok { color: #4ec9b0; }
    .status-exited-err { color: #f14c4c; }
    .empty { text-align: center; padding: 40px; color: #888; }
  </style>
</head>
<body>
  <h1>proc-web: Sessions</h1>
  ${hasControl ? `<div class="new-session">
    <input type="text" id="new-cmd" placeholder="Enter command to run…" autocomplete="off" />
    <button class="btn btn-primary" onclick="createSession()">Run</button>
  </div>` : ""}
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Command</th>
        <th>Status</th>
        <th>Started</th>
        <th>Duration</th>
        ${hasControl ? `<th>Actions</th>` : ""}
      </tr>
    </thead>
    <tbody id="sessions-body">
      ${rows || `<tr><td colspan="${hasControl ? 6 : 5}" class="empty">No sessions yet</td></tr>`}
    </tbody>
  </table>
  <script>
    const AUTH_TOKEN = ${authToken ? `'${authToken}'` : 'null'};
    function authHeaders() { return AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {}; }

    function createSession() {
      const input = document.getElementById('new-cmd');
      const cmd = input.value.trim();
      if (!cmd) return;
      const command = cmd.split(/\\s+/);
      fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ command }),
      })
      .then(r => r.json())
      .then(data => {
        if (data.id) {
          window.location.href = '/sessions/' + data.id;
        }
      })
      .catch(() => {});
    }

    document.getElementById('new-cmd').addEventListener('keydown', e => {
      if (e.key === 'Enter') createSession();
    });

    // Auto-refresh session list
    function refreshSessions() {
      fetch('/api/sessions')
        .then(r => r.json())
        .then(sessions => {
          const tbody = document.getElementById('sessions-body');
          const cols = ${hasControl} ? 6 : 5;
          if (sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="' + cols + '" class="empty">No sessions yet</td></tr>';
            return;
          }
          tbody.innerHTML = sessions.map(s => {
            const statusClass = s.processExited ? (s.exitCode === 0 ? 'status-exited-ok' : 'status-exited-err') : 'status-running';
            const statusText = s.processExited ? 'Exited (' + s.exitCode + ')' : 'Running';
            const startTime = new Date(s.startTime).toLocaleTimeString();
            const duration = s.durationMs ? (s.durationMs / 1000).toFixed(1) + 's' : '—';
            const cmd = s.command.join(' ');
            const shortId = s.id.slice(0, 8);
            const actions = ${hasControl} ? '<td><button class="btn" onclick="rerunSession(\\'' + s.id + '\\')">Rerun</button></td>' : '';
            return '<tr>' +
              '<td><a href="/sessions/' + s.id + '" class="session-link">' + shortId + '</a></td>' +
              '<td class="cmd-cell" title="' + cmd + '">' + cmd + '</td>' +
              '<td><span class="' + statusClass + '">' + statusText + '</span></td>' +
              '<td>' + startTime + '</td>' +
              '<td>' + duration + '</td>' +
              actions +
              '</tr>';
          }).join('');
        })
        .catch(() => {});
    }

    function rerunSession(sessionId) {
      fetch('/sessions/' + sessionId + '/rerun', {
        method: 'POST',
        headers: authHeaders(),
      })
      .then(r => r.json())
      .then(data => {
        if (data.id) window.location.href = '/sessions/' + data.id;
      })
      .catch(() => {});
    }

    setInterval(refreshSessions, 2000);
  </script>
</body>
</html>`;
}

function generateCompletedSessionHTML(meta: SessionMetadata, authToken: string | null, hasControl: boolean): string {
  const commandHtml = escapeHtml(meta.command.join(" "));
  const shortId = meta.id.slice(0, 8);
  const statusText = meta.spawnError ? "Spawn Error" : `Exited (${meta.exitCode})`;
  const statusClass = meta.spawnError || meta.exitCode !== 0 ? "status-exited" : "status-running";
  const startTime = new Date(meta.startTime).toLocaleString();
  const duration = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>proc-web: ${commandHtml}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
      min-height: 100vh;
      padding: 24px;
    }
    header {
      background: #2d2d2d;
      padding: 8px 16px;
      border-bottom: 1px solid #3d3d3d;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      border-radius: 6px;
      margin-bottom: 24px;
    }
    .logo { font-size: 14px; font-weight: 600; color: #4ec9b0; flex-shrink: 0; cursor: pointer; }
    .session-id { font-size: 11px; color: #888; font-family: Monaco, Menlo, monospace; flex-shrink: 0; }
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
    }
    .btn:hover { background: #4a4a4a; }
    .btn-primary { background: #4ec9b0; color: #1e1e1e; border-color: #4ec9b0; font-weight: 600; }
    .btn-primary:hover { background: #3db89e; }
    .details {
      background: #2d2d2d;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .details h3 { color: #4ec9b0; font-size: 14px; margin-bottom: 12px; }
    .detail-row { display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px; }
    .detail-label { color: #888; min-width: 100px; }
    .detail-value { color: #d4d4d4; font-family: Monaco, Menlo, monospace; }
  </style>
</head>
<body>
  <header>
    <span class="logo" onclick="window.location.href='/'">proc-web</span>
    <span class="session-id">${shortId}</span>
    <span class="command" title="${commandHtml}">${commandHtml}</span>
    <div class="header-right">
      <span class="${statusClass}">${statusText}</span>
      ${hasControl ? `<button class="btn btn-primary" onclick="rerunSession()">Rerun</button>` : ""}
    </div>
  </header>

  <div class="details">
    <h3>Session Details</h3>
    <div class="detail-row"><span class="detail-label">Session ID:</span><span class="detail-value">${meta.id}</span></div>
    <div class="detail-row"><span class="detail-label">Command:</span><span class="detail-value">${commandHtml}</span></div>
    <div class="detail-row"><span class="detail-label">Started:</span><span class="detail-value">${startTime}</span></div>
    <div class="detail-row"><span class="detail-label">Duration:</span><span class="detail-value">${duration}</span></div>
    <div class="detail-row"><span class="detail-label">Exit Code:</span><span class="detail-value">${meta.exitCode ?? "—"}</span></div>
    ${meta.spawnError ? `<div class="detail-row"><span class="detail-label">Error:</span><span class="detail-value">${escapeHtml(meta.spawnError)}</span></div>` : ""}
  </div>
  <div class="details">
    <h3>Downloads</h3>
    <div style="display: flex; gap: 8px;">
      <a class="btn" href="/sessions/${meta.id}/export/stdout" download>stdout.log</a>
      <a class="btn" href="/sessions/${meta.id}/export/stderr" download>stderr.log</a>
      <a class="btn" href="/sessions/${meta.id}/export/combined" download>combined.log</a>
      <a class="btn" href="/sessions/${meta.id}/export/metadata" download>metadata.json</a>
    </div>
  </div>
  <script>
    const AUTH_TOKEN = ${authToken ? `'${authToken}'` : "null"};
    function authHeaders() { return AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {}; }
    function rerunSession() {
      fetch('/sessions/${meta.id}/rerun', {
        method: 'POST',
        headers: authHeaders(),
      })
      .then(r => r.json())
      .then(data => {
        if (data.id) window.location.href = '/sessions/' + data.id;
      })
      .catch(() => {});
    }
  </script>
</body>
</html>`;
}

function generateSessionHTML(session: Session, authToken: string | null, hasControl: boolean): string {
  const commandHtml = escapeHtml(session.command.join(" "));
  const shortId = session.id.slice(0, 8);

  return `<!DOCTYPE html>
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
    .logo { font-size: 14px; font-weight: 600; color: #4ec9b0; flex-shrink: 0; cursor: pointer; }
    .session-id { font-size: 11px; color: #888; font-family: Monaco, Menlo, monospace; flex-shrink: 0; }
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
    <span class="logo" onclick="window.location.href='/'">proc-web</span>
    <span class="session-id">${shortId}</span>
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
      <button id="ts-btn" class="btn" onclick="cycleTimestamps()">⏱ Off</button>
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
    <button class="btn" onclick="sendSignalChar('\\x03')" title="Ctrl+C">Ctrl+C</button>
    <button class="btn" onclick="sendSignalChar('\\x04')" title="Ctrl+D">Ctrl+D</button>
    <button class="btn" onclick="sendSignal('SIGINT')" title="Send SIGINT">INT</button>
    <button class="btn" onclick="sendSignal('SIGTERM')" title="Send SIGTERM">TERM</button>
    <button class="btn btn-danger" onclick="sendSignal('SIGKILL')" title="Send SIGKILL">KILL</button>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-search@0.13.0/lib/xterm-addon-search.js"></script>
  <script>
    const SESSION_ID = '${session.id}';
    const SESSION_START_TIME = ${session.startTime};
    const AUTH_TOKEN = ${authToken ? `'${authToken}'` : 'null'};
    const HAS_CONTROL = ${hasControl};
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

    let currentTab = 'stdout';
    let autoScroll = true;
    const writeBuffers = { stdout: [], stderr: [], combined: [] };
    let flushScheduled = false;
    let timestampMode = 'off';
    const atLineStart = { stdout: true, stderr: true, combined: true };

    function getTimestamp() {
      const now = Date.now();
      if (timestampMode === 'absolute') {
        return new Date(now).toLocaleTimeString();
      }
      return '+' + ((now - SESSION_START_TIME) / 1000).toFixed(1) + 's';
    }

    function injectTimestamps(name, data) {
      if (timestampMode === 'off') return data;
      const ts = getTimestamp();
      const prefix = '\\x1b[90m[' + ts + ']\\x1b[0m ';
      let result = '';
      let i = 0;
      while (i < data.length) {
        if (data.charCodeAt(i) === 0x1b && i + 1 < data.length && data[i + 1] === '[') {
          const end = data.indexOf('m', i + 2);
          if (end !== -1) {
            result += data.slice(i, end + 1);
            i = end + 1;
            continue;
          }
        }
        if (atLineStart[name]) {
          result += prefix;
          atLineStart[name] = false;
        }
        result += data[i];
        if (data[i] === '\\n') atLineStart[name] = true;
        i++;
      }
      return result;
    }

    function cycleTimestamps() {
      const modes = ['off', 'absolute', 'relative'];
      const idx = modes.indexOf(timestampMode);
      timestampMode = modes[(idx + 1) % modes.length];
      const btn = document.getElementById('ts-btn');
      const labels = { off: '⏱ Off', absolute: '⏱ Abs', relative: '⏱ Rel' };
      btn.textContent = labels[timestampMode];
    }

    function flushBuffers() {
      flushScheduled = false;
      for (const name of Object.keys(panels)) {
        const buf = writeBuffers[name];
        if (buf.length > 0) {
          writeBuffers[name] = [];
          panels[name].terminal.write(buf.join(''));
        }
      }
      if (autoScroll) panels[currentTab].terminal.scrollToBottom();
    }

    function sendResize() {
      const term = panels[currentTab].terminal;
      fetch('/sessions/' + SESSION_ID + '/resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      }).catch(() => {});
    }
    function fitActivePanel() {
      try { panels[currentTab].fitAddon.fit(); } catch (_) {}
      sendResize();
    }
    fitActivePanel();
    window.addEventListener('resize', fitActivePanel);
    function switchTab(name) {
      const buf = writeBuffers[name];
      if (buf.length > 0) {
        writeBuffers[name] = [];
        panels[name].terminal.write(buf.join(''));
      }
      currentTab = name;
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.panel').forEach(p =>
        p.classList.toggle('active', p.id === 'panel-' + name));
      requestAnimationFrame(() => {
        try { panels[name].fitAddon.fit(); } catch (_) {}
        if (autoScroll) panels[name].terminal.scrollToBottom();
      });
    }

    function toggleScroll() {
      autoScroll = !autoScroll;
      const btn = document.getElementById('scroll-btn');
      btn.textContent = autoScroll ? '\\u23f8 Pause' : '\\u25b6 Resume';
      if (autoScroll) {
        flushBuffers();
        Object.values(panels).forEach(p => p.terminal.scrollToBottom());
      }
    }

    function writeToTerminal(name, data) {
      data = injectTimestamps(name, data);
      writeBuffers[name].push(data);
      if (name === currentTab && !flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(flushBuffers);
      }
    }

    let processExited = false;
    function updateStatus() {
      fetch('/sessions/' + SESSION_ID + '/status').then(r => r.json()).then(s => {
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

    function killProcess() {
      fetch('/sessions/' + SESSION_ID + '/kill', { method: 'POST', headers: authHeaders() }).catch(() => {});
    }

    function sendStdin() {
      const inp = document.getElementById('stdin-input');
      const text = inp.value;
      if (!text) return;
      fetch('/sessions/' + SESSION_ID + '/stdin', { method: 'POST', body: text, headers: authHeaders() }).catch(() => {});
      inp.value = '';
    }
    function sendSignalChar(ch) {
      fetch('/sessions/' + SESSION_ID + '/stdin?raw=1', { method: 'POST', body: ch, headers: authHeaders() }).catch(() => {});
    }
    function sendSignal(sig) {
      fetch('/sessions/' + SESSION_ID + '/signal', { method: 'POST', body: JSON.stringify({ signal: sig }), headers: { 'Content-Type': 'application/json', ...authHeaders() } }).catch(() => {});
    }
    document.getElementById('stdin-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendStdin();
    });

    function downloadOutput() {
      const a = document.createElement('a');
      a.href = '/sessions/' + SESSION_ID + '/export/' + currentTab;
      a.download = currentTab + '.log';
      a.click();
    }

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

    let stdoutLastId = -1, stderrLastId = -1, combinedLastId = -1;

    connectSSE(() => '/sessions/' + SESSION_ID + '/stdout' + (stdoutLastId >= 0 ? '?from=' + (stdoutLastId + 1) : ''), source => {
      source.onmessage = e => { if (e.lastEventId) stdoutLastId = parseInt(e.lastEventId); writeToTerminal('stdout', decodeBase64(e.data)); };
    });

    connectSSE(() => '/sessions/' + SESSION_ID + '/stderr' + (stderrLastId >= 0 ? '?from=' + (stderrLastId + 1) : ''), source => {
      source.onmessage = e => { if (e.lastEventId) stderrLastId = parseInt(e.lastEventId); writeToTerminal('stderr', decodeBase64(e.data)); };
    });

    connectSSE(() => '/sessions/' + SESSION_ID + '/combined' + (combinedLastId >= 0 ? '?from=' + (combinedLastId + 1) : ''), source => {
      source.addEventListener('stdout', e => {
        if (e.lastEventId) combinedLastId = parseInt(e.lastEventId);
        writeToTerminal('combined', decodeBase64(e.data));
      });
      source.addEventListener('stderr', e => {
        if (e.lastEventId) combinedLastId = parseInt(e.lastEventId);
        writeToTerminal('combined', '\\x1b[31m' + decodeBase64(e.data) + '\\x1b[0m');
      });
      source.onmessage = e => writeToTerminal('combined', decodeBase64(e.data));
    });
  </script>
</body>
</html>`;
}
