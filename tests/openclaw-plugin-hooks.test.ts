import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
import { SessionDB } from "../src/session/db.js";

// ── Helpers ──────────────────────────────────────────────

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `plugin-hooks-test-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

// ── Mock API ─────────────────────────────────────────────

interface RegisteredHook {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

function createMockApi() {
  const hooks: RegisteredHook[] = [];
  const typedHooks: RegisteredHook[] = [];

  const api = {
    registerHook(event: string, handler: (...args: unknown[]) => unknown, _meta: unknown) {
      hooks.push({ hookName: event, handler });
    },
    on(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) {
      typedHooks.push({ hookName, handler, opts });
    },
    registerContextEngine(_id: string, _factory: () => unknown) {},
    registerCommand(_cmd: unknown) {},
  };

  return { api, hooks, typedHooks };
}

// ── Plugin shape test ────────────────────────────────────

describe("Plugin exports", () => {
  beforeEach(() => { vi.resetModules(); });

  test("plugin exports id, name, configSchema, register", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    assert.equal(plugin.id, "context-mode");
    assert.equal(plugin.name, "Context Mode");
    assert.ok(plugin.configSchema);
    assert.equal(typeof plugin.register, "function");
  });
});

describe("session_start hook", () => {
  beforeEach(() => { vi.resetModules(); });

  test("session_start hook is registered", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook, "session_start hook must be registered");
  });

  test("session_start hook is registered with no priority (void hook)", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook, "session_start must be registered");
    assert.equal(hook.opts?.priority, undefined);
  });

  test("session_start handler resets resumeInjected — verified via before_prompt_build sequence", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const sessionStartHandler = typedHooks.find(h => h.hookName === "session_start")?.handler;
    assert.ok(sessionStartHandler, "session_start handler must exist");

    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook, "resume before_prompt_build hook must exist");

    // Call before_prompt_build first time — returns undefined (no DB resume)
    const result1 = await resumeHook.handler();
    assert.equal(result1, undefined, "no resume in DB → undefined");

    // Call session_start (simulating session restart)
    await sessionStartHandler({ sessionId: randomUUID() });

    // Call before_prompt_build again — still undefined (no DB resume), but must not throw
    const result2 = await resumeHook.handler();
    assert.equal(result2, undefined, "after session_start reset, still no resume → undefined");
  });
});

describe("compaction hooks", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_compaction hook is registered", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "before_compaction");
    assert.ok(hook, "before_compaction must be registered");
  });

  test("after_compaction hook is registered", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "after_compaction");
    assert.ok(hook, "after_compaction must be registered");
  });

  test("before_compaction DB logic: flushes events to resume snapshot", async () => {
    // Test the DB-layer logic directly (independent of plugin closures)
    const { buildResumeSnapshot } = await import("../src/session/snapshot.js");
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    // Insert a fake event
    db.insertEvent(sid, {
      type: "file",
      category: "file",
      data: "/src/test.ts",
      priority: 2,
      data_hash: "",
    } as unknown as import("../src/types.js").SessionEvent, "PostToolUse");

    // Simulate before_compaction logic
    const events = db.getEvents(sid);
    assert.equal(events.length, 1);

    const stats = db.getSessionStats(sid);
    const snapshot = buildResumeSnapshot(events, {
      compactCount: (stats?.compact_count ?? 0) + 1,
    });
    db.upsertResume(sid, snapshot, events.length);

    const resume = db.getResume(sid);
    assert.ok(resume, "resume must exist after flush");
    assert.ok(resume.snapshot.length > 0, "snapshot must be non-empty");
  });
});

describe("resume injection (before_prompt_build)", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_prompt_build resume hook is registered at priority 10", async () => {
    const { default: plugin } = await import("../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApi();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook, "resume before_prompt_build hook must be registered at priority 10");
  });

  test("resume injection returns prependSystemContext when resume exists and compact_count > 0", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    db.upsertResume(sid, "## Resume\n\n- Did something", 3);
    db.incrementCompactCount(sid);

    const resume = db.getResume(sid);
    const stats = db.getSessionStats(sid);

    assert.ok(resume, "resume must exist");
    assert.ok((stats?.compact_count ?? 0) > 0, "compact_count must be > 0");

    const result = resume && (stats?.compact_count ?? 0) > 0
      ? { prependSystemContext: resume.snapshot }
      : undefined;

    assert.ok(result, "result must be defined");
    assert.ok(result.prependSystemContext.includes("## Resume"), "must include resume content");
  });

  test("resume injection returns undefined when no resume exists", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    const resume = db.getResume(sid);
    assert.equal(resume, null, "new session has no resume");

    const result = resume ? { prependSystemContext: resume.snapshot } : undefined;
    assert.equal(result, undefined, "must return undefined if no resume");
  });

  test("resume injection returns undefined when compact_count is 0", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    db.upsertResume(sid, "## Resume\n\n- Did something", 1);

    const resume = db.getResume(sid);
    const stats = db.getSessionStats(sid);
    assert.ok(resume, "resume exists");
    assert.equal(stats?.compact_count ?? 0, 0, "compact_count is 0");

    const result = resume && (stats?.compact_count ?? 0) > 0
      ? { prependSystemContext: resume.snapshot }
      : undefined;
    assert.equal(result, undefined, "must return undefined if compact_count is 0");
  });
});
