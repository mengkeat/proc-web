import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";

const TEST_PORT = 3456;
const TEST_LOG_DIR = "/tmp/proc-web-test-logs-" + Date.now();
const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`;

let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function startServer(args: string[] = []): Promise<void> {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });

  serverProc = Bun.spawn(["bun", "run", "server.ts", "--port", String(TEST_PORT), "--log-dir", TEST_LOG_DIR, ...args, "echo", "test-output"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error("Server did not start in time");
}

async function stopServer(): Promise<void> {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
    serverProc = null;
  }
}

function cleanup(): void {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
}

describe("Phase 4.1: Introduce sessions", () => {
  test("GET /api/sessions returns session list", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      expect(res.status).toBe(200);
      const sessions = await res.json();
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);

      const session = sessions[0];
      expect(session.id).toBeDefined();
      expect(session.command).toEqual(["echo", "test-output"]);
      expect(session.startTime).toBeGreaterThan(0);
      expect(typeof session.processExited).toBe("boolean");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("POST /api/sessions creates a new session", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: ["echo", "new-session"] }),
      });
      expect(res.status).toBe(201);
      const session = await res.json();
      expect(session.id).toBeDefined();
      expect(session.command).toEqual(["echo", "new-session"]);
      expect(session.processExited).toBe(false);
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/:id/status returns session status", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const statusRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/status`);
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json();
      expect(typeof status.running).toBe("boolean");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/:id returns session view HTML", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      expect(viewRes.status).toBe(200);
      const html = await viewRes.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain(sessionId.slice(0, 8));
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET / returns session list page", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("proc-web");
      expect(html).toContain("Sessions");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/nonexistent returns 404", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/sessions/nonexistent`);
      expect(res.status).toBe(404);
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("sessions persist across server restarts with --log-dir", async () => {
    await startServer();
    let sessionId: string;
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      sessionId = sessions[0].id;
    } finally {
      await stopServer();
    }

    // Wait briefly for process exit and metadata write
    await Bun.sleep(500);

    // Verify metadata was written to disk
    const metaFiles = existsSync(TEST_LOG_DIR)
      ? (await Bun.$`ls ${TEST_LOG_DIR}`.text()).trim().split("\n")
      : [];
    expect(metaFiles.length).toBeGreaterThanOrEqual(1);

    // Restart server with same log dir
    serverProc = Bun.spawn(["bun", "run", "server.ts", "--port", String(TEST_PORT), "--log-dir", TEST_LOG_DIR, "echo", "second-run"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${SERVER_URL}/api/sessions`);
        if (res.ok) break;
      } catch {}
      await Bun.sleep(200);
    }

    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const oldSession = sessions.find((s: any) => s.id === sessionId);
      expect(oldSession).toBeDefined();
      expect(oldSession.command).toEqual(["echo", "test-output"]);
      expect(oldSession.exitCode).toBe(0);
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session metadata has correct structure", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const session = sessions[0];

      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("command");
      expect(session).toHaveProperty("startTime");
      expect(session).toHaveProperty("endTime");
      expect(session).toHaveProperty("durationMs");
      expect(session).toHaveProperty("exitCode");
      expect(session).toHaveProperty("spawnError");
      expect(session).toHaveProperty("processExited");
      expect(session).toHaveProperty("pty");

      expect(typeof session.id).toBe("string");
      expect(Array.isArray(session.command)).toBe(true);
      expect(typeof session.startTime).toBe("number");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session list page shows session details", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sessions");
      expect(html).toContain("ID");
      expect(html).toContain("Command");
      expect(html).toContain("Status");
      expect(html).toContain("Started");
      expect(html).toContain("Duration");
      // Should show at least one session link
      expect(html).toContain("session-link");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("POST /sessions/:id/rerun creates a new session with same command", async () => {
    await startServer();
    try {
      // Get the initial session
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const originalId = sessions[0].id;
      const originalCmd = sessions[0].command;

      // Rerun the session
      const rerunRes = await fetch(`${SERVER_URL}/sessions/${originalId}/rerun`, {
        method: "POST",
      });
      expect(rerunRes.status).toBe(201);
      const newSession = await rerunRes.json();
      expect(newSession.id).toBeDefined();
      expect(newSession.id).not.toBe(originalId);
      expect(newSession.command).toEqual(originalCmd);

      // Verify both sessions exist in the list
      const listRes = await fetch(`${SERVER_URL}/api/sessions`);
      const allSessions = await listRes.json();
      expect(allSessions.length).toBeGreaterThanOrEqual(2);
      expect(allSessions.find((s: any) => s.id === originalId)).toBeDefined();
      expect(allSessions.find((s: any) => s.id === newSession.id)).toBeDefined();
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("POST /sessions/:id/rerun returns 404 for unknown session", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/sessions/nonexistent/rerun`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/:id/export/metadata returns session metadata", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const exportRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/export/metadata`);
      expect(exportRes.status).toBe(200);
      const meta = await exportRes.json();
      expect(meta.id).toBe(sessionId);
      expect(meta.command).toEqual(["echo", "test-output"]);
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/:id/export/stdout returns stdout log", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const exportRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/export/stdout`);
      expect(exportRes.status).toBe(200);
      const content = await exportRes.text();
      expect(content).toContain("test-output");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/:id/export/stderr returns stderr log", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const exportRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/export/stderr`);
      expect(exportRes.status).toBe(200);
      // stderr might be empty, but should still return 200
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("GET /sessions/:id/export/combined returns combined log", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const exportRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/export/combined`);
      expect(exportRes.status).toBe(200);
      const content = await exportRes.text();
      expect(content).toContain("test-output");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("export from completed session after restart reads from disk", async () => {
    await startServer();
    let sessionId: string;
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      sessionId = sessions[0].id;
    } finally {
      await stopServer();
    }

    await Bun.sleep(500);

    // Restart server
    serverProc = Bun.spawn(["bun", "run", "server.ts", "--port", String(TEST_PORT), "--log-dir", TEST_LOG_DIR, "echo", "second"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${SERVER_URL}/api/sessions`);
        if (res.ok) break;
      } catch {}
      await Bun.sleep(200);
    }

    try {
      // Export stdout from old session (from disk)
      const stdoutRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/export/stdout`);
      expect(stdoutRes.status).toBe(200);
      const content = await stdoutRes.text();
      expect(content).toContain("test-output");

      // Export metadata from old session (from disk)
      const metaRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/export/metadata`);
      expect(metaRes.status).toBe(200);
      const meta = await metaRes.json();
      expect(meta.id).toBe(sessionId);
    } finally {
      await stopServer();
      cleanup();
    }
  });
});

describe("Phase 5.1: Timestamps toggle", () => {
  test("session HTML includes timestamp toggle button and logic", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      expect(viewRes.status).toBe(200);
      const html = await viewRes.text();
      expect(html).toContain("cycleTimestamps()");
      expect(html).toContain("timestampMode");
      expect(html).toContain("injectTimestamps");
      expect(html).toContain("SESSION_START_TIME");
      expect(html).toContain("ts-btn");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("status endpoint returns startTime and viewerCount", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const statusRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/status`);
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json();
      expect(typeof status.startTime).toBe("number");
      expect(status.startTime).toBeGreaterThan(0);
      expect(typeof status.viewerCount).toBe("number");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("download uses server-side export endpoint", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("/export/' + currentTab");
    } finally {
      await stopServer();
      cleanup();
    }
  });
});

describe("Phase 5.3: Improved client rendering performance", () => {
  test("session HTML includes write batching for rendering performance", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      expect(viewRes.status).toBe(200);
      const html = await viewRes.text();
      expect(html).toContain("writeBuffers");
      expect(html).toContain("flushBuffers");
      expect(html).toContain("requestAnimationFrame(flushBuffers)");
      expect(html).toContain("flushScheduled");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("writeToTerminal uses panel name instead of terminal object", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("writeToTerminal('stdout'");
      expect(html).toContain("writeToTerminal('stderr'");
      expect(html).toContain("writeToTerminal('combined'");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("switchTab flushes buffer for new tab", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toMatch(/switchTab\(name\)[\s\S]*?writeBuffers\[name\]/);
    } finally {
      await stopServer();
      cleanup();
    }
  });
});

describe("Phase 5.2: Better output filtering and navigation", () => {
  test("session HTML includes combined view filter buttons", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;
      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("setCombinedFilter('all')");
      expect(html).toContain("setCombinedFilter('stdout')");
      expect(html).toContain("setCombinedFilter('stderr')");
      expect(html).toContain("combined-filter");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session HTML includes wrap toggle and error jump", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;
      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("toggleWrap()");
      expect(html).toContain("jumpError(-1)");
      expect(html).toContain("jumpError(1)");
      expect(html).toContain("ERROR_PATTERN");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session HTML includes chunk count tracking", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;
      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("chunkCounts");
      expect(html).toContain("updateChunkCounts");
      expect(html).toContain("count-stdout");
      expect(html).toContain("count-stderr");
      expect(html).toContain("count-combined");
    } finally {
      await stopServer();
      cleanup();
    }
  });
});

describe("Phase 5.4: Visual polish and UX refinements", () => {
  test("status endpoint returns bytesStreamed", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const statusRes = await fetch(`${SERVER_URL}/sessions/${sessionId}/status`);
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json();
      expect(typeof status.bytesStreamed).toBe("number");
      expect(status.bytesStreamed).toBeGreaterThanOrEqual(0);
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session HTML includes runtime and viewer display", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("formatDuration");
      expect(html).toContain("formatBytes");
      expect(html).toContain("status-info");
      expect(html).toContain("viewer");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session HTML includes responsive CSS media queries", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("@media (max-width: 768px)");
      expect(html).toContain("@media (max-width: 480px)");
    } finally {
      await stopServer();
      cleanup();
    }
  });

  test("session HTML includes button focus and active states", async () => {
    await startServer();
    try {
      const res = await fetch(`${SERVER_URL}/api/sessions`);
      const sessions = await res.json();
      const sessionId = sessions[0].id;

      const viewRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`);
      const html = await viewRes.text();
      expect(html).toContain("focus-visible");
      expect(html).toContain(":active");
    } finally {
      await stopServer();
      cleanup();
    }
  });
});
