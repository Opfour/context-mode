/**
 * AnalyticsEngine — All 27 metrics from SessionDB.
 *
 * Computes session-level and cross-session analytics using SQL queries
 * and JavaScript post-processing. Groups:
 *
 *  Group 1 (SQL Direct):    17 metrics — direct SQL against session tables
 *  Group 2 (JS Computed):    3 metrics — SQL + JS post-processing
 *  Group 3 (Runtime):        4 metrics — stubs for server.ts tracking
 *  Group 4 (New Extractor):  3 metrics — stubs for future extractors
 *
 * Usage:
 *   const engine = new AnalyticsEngine(sessionDb);
 *   const report = engine.queryAll(runtimeStats);
 */

import type { SessionDB } from "./db.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Weekly trend data point */
export interface WeeklyTrendRow {
  day: string;
  sessions: number;
}

/** Category distribution row */
export interface ContinuityRow {
  category: string;
  count: number;
}

/** Hourly productivity row */
export interface HourlyRow {
  hour: string;
  count: number;
}

/** Project distribution row */
export interface ProjectRow {
  project_dir: string;
  sessions: number;
}

/** CLAUDE.md freshness row */
export interface FreshnessRow {
  data: string;
  last_updated: string;
}

/** Rework rate row */
export interface ReworkRow {
  data: string;
  edits: number;
}

/** Subagent usage row */
export interface SubagentRow {
  data: string;
  total: number;
}

/** Skill usage row */
export interface SkillRow {
  data: string;
  invocations: number;
}

/** Context savings result (#1) */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Think in code comparison result (#2) */
export interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

/** Tool-level savings result (#3) */
export interface ToolSavingsRow {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

/** Sandbox I/O result (#19) */
export interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

/** Pattern insight result (#6) */
export interface PatternInsight {
  pattern: string;
  confidence: number;
}

// ─────────────────────────────────────────────────────────
// Runtime stats — passed in from server.ts (can't come from DB)
// ─────────────────────────────────────────────────────────

/** Runtime stats tracked by server.ts during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheBytesSaved: number;
}

// ─────────────────────────────────────────────────────────
// FullReport — single unified object returned by queryAll()
// ─────────────────────────────────────────────────────────

/** Unified report combining runtime stats, DB analytics, and continuity data. */
export interface FullReport {
  /** Runtime context savings (passed in, not from DB) */
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  cache?: {
    hits: number;
    bytes_saved: number;
    ttl_hours_left: number;
    total_with_cache: number;
    total_savings_ratio: number;
  };
  /** Session metadata from SessionDB */
  session: {
    id: string;
    duration_min: number | null;
    tool_calls: number;
    uptime_min: string;
  };
  /** Activity metrics */
  activity: {
    commits: number;
    errors: number;
    error_rate_pct: number;
    tool_diversity: number;
    efficiency_score: number;
    commits_per_session_avg: number;
    session_outcome: string;
    productive_pct: number;
    exploratory_pct: number;
  };
  /** Pattern metrics */
  patterns: {
    hourly_commits: number[];
    weekly_trend: Array<{ day: string; sessions: number }>;
    iteration_cycles: number;
    rework: Array<{ file: string; edits: number }>;
  };
  /** Health metrics */
  health: {
    claude_md_freshness: Array<{ project: string; days_ago: number | null }>;
    compactions_this_week: number;
    weekly_sessions: number;
    permission_denials: number;
  };
  /** Agent metrics */
  agents: {
    subagents: Array<{ type: string; count: number }>;
    skills: Array<{ name: string; count: number }>;
  };
  /** Session continuity data */
  continuity: {
    total_events: number;
    by_category: Array<{
      category: string;
      count: number;
      label: string;
      preview: string;
      why: string;
    }>;
    compact_count: number;
    resume_ready: boolean;
  };
}

// ─────────────────────────────────────────────────────────
// Category labels and hints for session continuity display
// ─────────────────────────────────────────────────────────

/** Human-readable labels for event categories. */
export const categoryLabels: Record<string, string> = {
  file: "Files tracked",
  rule: "Project rules (CLAUDE.md)",
  prompt: "Your requests saved",
  mcp: "Plugin tools used",
  git: "Git operations",
  env: "Environment setup",
  error: "Errors caught",
  task: "Tasks in progress",
  decision: "Your decisions",
  cwd: "Working directory",
  skill: "Skills used",
  subagent: "Delegated work",
  intent: "Session mode",
  data: "Data references",
  role: "Behavioral directives",
};

/** Explains why each category matters for continuity. */
export const categoryHints: Record<string, string> = {
  file: "Restored after compact \u2014 no need to re-read",
  rule: "Your project instructions survive context resets",
  prompt: "Continues exactly where you left off",
  decision: "Applied automatically \u2014 won\u2019t ask again",
  task: "Picks up from where it stopped",
  error: "Tracked and monitored across compacts",
  git: "Branch, commit, and repo state preserved",
  env: "Runtime config carried forward",
  mcp: "Tool usage patterns remembered",
  subagent: "Delegation history preserved",
  skill: "Skill invocations tracked",
};

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  /**
   * Create an AnalyticsEngine.
   *
   * Accepts either a SessionDB instance (extracts internal db via
   * the protected getter — use the static fromDB helper for raw adapters)
   * or any object with a prepare() method for direct usage.
   */
  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 1 — SQL Direct (17 metrics)
  // ═══════════════════════════════════════════════════════

  /**
   * #5 Weekly Trend — sessions started per day over the last 7 days.
   * Returns an array of { day, sessions } sorted by day.
   */
  weeklyTrend(): WeeklyTrendRow[] {
    return this.db.prepare(
      `SELECT date(started_at) as day, COUNT(*) as sessions
       FROM session_meta
       WHERE started_at > datetime('now', '-7 days')
       GROUP BY day`,
    ).all() as WeeklyTrendRow[];
  }

  /**
   * #7 Session Continuity — event category distribution for a session.
   * Shows what the session focused on (file ops, git, errors, etc.).
   */
  sessionContinuity(sessionId: string): ContinuityRow[] {
    return this.db.prepare(
      `SELECT category, COUNT(*) as count
       FROM session_events
       WHERE session_id = ?
       GROUP BY category`,
    ).all(sessionId) as ContinuityRow[];
  }

  /**
   * #8 Commit Count — number of git commits made during a session.
   * Matches events where category='git' and data contains 'commit'.
   */
  commitCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'git' AND data LIKE '%commit%'`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * #9 Error Count — total error events in a session.
   */
  errorCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'error'`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * #10 Session Duration — elapsed minutes from session start to last event.
   * Returns null if last_event_at is not set (session still initializing).
   */
  sessionDuration(sessionId: string): number | null {
    const row = this.db.prepare(
      `SELECT (julianday(last_event_at) - julianday(started_at)) * 24 * 60 as minutes
       FROM session_meta
       WHERE session_id = ?`,
    ).get(sessionId) as { minutes: number | null } | undefined;
    return row?.minutes ?? null;
  }

  /**
   * #11 Error Rate — percentage of events that are errors in a session.
   * Returns 0 for sessions with no events (division by zero protection).
   */
  errorRate(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT ROUND(100.0 * SUM(CASE WHEN category='error' THEN 1 ELSE 0 END) / COUNT(*), 1) as rate
       FROM session_events
       WHERE session_id = ?`,
    ).get(sessionId) as { rate: number | null };
    return row.rate ?? 0;
  }

  /**
   * #12 Tool Diversity — number of distinct MCP tools used in a session.
   * Higher diversity suggests more sophisticated tool usage.
   */
  toolDiversity(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT data) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'mcp'`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * #14 Hourly Productivity — event distribution by hour of day.
   * Optionally scoped to a session; omit sessionId for all sessions.
   */
  hourlyProductivity(sessionId?: string): HourlyRow[] {
    if (sessionId) {
      return this.db.prepare(
        `SELECT strftime('%H', created_at) as hour, COUNT(*) as count
         FROM session_events
         WHERE session_id = ?
         GROUP BY hour`,
      ).all(sessionId) as HourlyRow[];
    }
    return this.db.prepare(
      `SELECT strftime('%H', created_at) as hour, COUNT(*) as count
       FROM session_events
       GROUP BY hour`,
    ).all() as HourlyRow[];
  }

  /**
   * #15 Project Distribution — session count per project directory.
   * Sorted descending by session count.
   */
  projectDistribution(): ProjectRow[] {
    return this.db.prepare(
      `SELECT project_dir, COUNT(*) as sessions
       FROM session_meta
       GROUP BY project_dir
       ORDER BY sessions DESC`,
    ).all() as ProjectRow[];
  }

  /**
   * #16 Compaction Count — number of snapshot compactions for a session.
   * Higher counts indicate longer/more active sessions.
   */
  compactionCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT compact_count
       FROM session_meta
       WHERE session_id = ?`,
    ).get(sessionId) as { compact_count: number } | undefined;
    return row?.compact_count ?? 0;
  }

  /**
   * #17 Weekly Session Count — total sessions started in the last 7 days.
   */
  weeklySessionCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_meta
       WHERE started_at > datetime('now', '-7 days')`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * #18 Commits Per Session — average commits across all sessions.
   * Returns 0 when no sessions exist (NULLIF prevents division by zero).
   */
  commitsPerSession(): number {
    const row = this.db.prepare(
      `SELECT ROUND(1.0 * (SELECT COUNT(*) FROM session_events WHERE category='git' AND data LIKE '%commit%')
        / NULLIF((SELECT COUNT(DISTINCT session_id) FROM session_meta), 0), 1) as avg`,
    ).get() as { avg: number | null };
    return row.avg ?? 0;
  }

  /**
   * #22 CLAUDE.md Freshness — last update timestamp for each rule file.
   * Helps identify stale configuration files.
   */
  claudeMdFreshness(): FreshnessRow[] {
    return this.db.prepare(
      `SELECT data, MAX(created_at) as last_updated
       FROM session_events
       WHERE category = 'rule'
       GROUP BY data`,
    ).all() as FreshnessRow[];
  }

  /**
   * #24 Rework Rate — files edited more than once (indicates iteration/rework).
   * Sorted descending by edit count.
   */
  reworkRate(sessionId?: string): ReworkRow[] {
    if (sessionId) {
      return this.db.prepare(
        `SELECT data, COUNT(*) as edits
         FROM session_events
         WHERE session_id = ? AND category = 'file'
         GROUP BY data
         HAVING edits > 1
         ORDER BY edits DESC`,
      ).all(sessionId) as ReworkRow[];
    }
    return this.db.prepare(
      `SELECT data, COUNT(*) as edits
       FROM session_events
       WHERE category = 'file'
       GROUP BY data
       HAVING edits > 1
       ORDER BY edits DESC`,
    ).all() as ReworkRow[];
  }

  /**
   * #25 Session Outcome — classify a session as 'productive' or 'exploratory'.
   * Productive: has at least one commit AND last event is not an error.
   */
  sessionOutcome(sessionId: string): "productive" | "exploratory" {
    const row = this.db.prepare(`
      SELECT CASE
        WHEN EXISTS(SELECT 1 FROM session_events WHERE session_id=? AND category='git' AND data LIKE '%commit%')
         AND NOT EXISTS(SELECT 1 FROM session_events WHERE session_id=?
             AND category='error' AND id=(SELECT MAX(id) FROM session_events WHERE session_id=?))
        THEN 'productive'
        ELSE 'exploratory'
      END as outcome
    `).get(sessionId, sessionId, sessionId) as { outcome: "productive" | "exploratory" };
    return row.outcome;
  }

  /**
   * #26 Subagent Usage — subagent spawn counts grouped by type/purpose.
   */
  subagentUsage(sessionId: string): SubagentRow[] {
    return this.db.prepare(
      `SELECT COUNT(*) as total, data
       FROM session_events
       WHERE session_id = ? AND category = 'subagent'
       GROUP BY data`,
    ).all(sessionId) as SubagentRow[];
  }

  /**
   * #27 Skill Usage — skill/slash-command invocation frequency.
   * Sorted descending by invocation count.
   */
  skillUsage(sessionId: string): SkillRow[] {
    return this.db.prepare(
      `SELECT data, COUNT(*) as invocations
       FROM session_events
       WHERE session_id = ? AND category = 'skill'
       GROUP BY data
       ORDER BY invocations DESC`,
    ).all(sessionId) as SkillRow[];
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 2 — JS Computed (3 metrics)
  // ═══════════════════════════════════════════════════════

  /**
   * #4 Session Mix — percentage of sessions classified as productive.
   * Iterates all sessions and uses #25 (sessionOutcome) to classify each.
   */
  sessionMix(): { productive: number; exploratory: number } {
    const sessions = this.db.prepare(
      `SELECT session_id FROM session_meta`,
    ).all() as Array<{ session_id: string }>;

    if (sessions.length === 0) {
      return { productive: 0, exploratory: 0 };
    }

    let productiveCount = 0;
    for (const s of sessions) {
      if (this.sessionOutcome(s.session_id) === "productive") {
        productiveCount++;
      }
    }

    const productivePct = Math.round((100 * productiveCount) / sessions.length);
    return {
      productive: productivePct,
      exploratory: 100 - productivePct,
    };
  }

  /**
   * #13 / #20 Efficiency Score — composite score (0-100) measuring session productivity.
   *
   * Components:
   *  - Error rate (lower = better): weight 30%
   *  - Tool diversity (higher = better): weight 20%
   *  - Commit presence (boolean bonus): weight 25%
   *  - Rework rate (lower = better): weight 15%
   *  - Session duration efficiency (moderate = better): weight 10%
   *
   * Formula: score = 100 - errorPenalty + diversityBonus + commitBonus - reworkPenalty + durationBonus - 40
   * The -40 baseline prevents empty sessions from scoring 100.
   */
  efficiencyScore(sessionId: string): number {
    const errRate = this.errorRate(sessionId);
    const diversity = this.toolDiversity(sessionId);
    const commits = this.commitCount(sessionId);

    const totalEvents = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number }).cnt;

    const fileEvents = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'file'`,
    ).get(sessionId) as { cnt: number }).cnt;

    // Rework: files edited more than once in this session
    const reworkFiles = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM (SELECT data, COUNT(*) as edits FROM session_events WHERE session_id = ? AND category = 'file' GROUP BY data HAVING edits > 1)`,
    ).get(sessionId) as { cnt: number };
    const reworkRatio = fileEvents > 0 ? reworkFiles.cnt / fileEvents : 0;

    // Duration in minutes
    const duration = this.sessionDuration(sessionId) ?? 0;

    // Score components
    const errorPenalty = Math.min(errRate * 0.3, 30);
    const diversityBonus = Math.min(diversity * 4, 20);
    const commitBonus = commits > 0 ? 25 : 0;
    const reworkPenalty = Math.min(reworkRatio * 15, 15);
    const durationBonus = duration > 5 && duration < 60 ? 10 : duration >= 60 ? 5 : 0;

    const score = Math.round(
      Math.max(0, Math.min(100,
        100 - errorPenalty + diversityBonus + commitBonus - reworkPenalty + durationBonus - 40,
      )),
    );
    return score;
  }

  /**
   * #23 Iteration Cycles — counts edit-error-fix sequences in a session.
   *
   * Walks events chronologically and detects patterns where a file event
   * is followed by an error event, then another file event.
   */
  iterationCycles(sessionId: string): number {
    const events = this.db.prepare(
      `SELECT category, data FROM session_events WHERE session_id = ? ORDER BY id ASC`,
    ).all(sessionId) as Array<{ category: string; data: string }>;

    let cycles = 0;
    for (let i = 0; i < events.length - 2; i++) {
      if (
        events[i].category === "file" &&
        events[i + 1].category === "error" &&
        events[i + 2].category === "file"
      ) {
        cycles++;
        i += 2; // Skip past this cycle
      }
    }
    return cycles;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 3 — Runtime (4 metrics, stubs)
  // ═══════════════════════════════════════════════════════

  /**
   * #1 Context Savings Total — bytes kept out of context window.
   *
   * Stub: requires server.ts to accumulate rawBytes and contextBytes
   * during a live session. Call with tracked values.
   */
  static contextSavingsTotal(rawBytes: number, contextBytes: number): ContextSavings {
    const savedBytes = rawBytes - contextBytes;
    const savedPercent = rawBytes > 0
      ? Math.round((savedBytes / rawBytes) * 1000) / 10
      : 0;
    return { rawBytes, contextBytes, savedBytes, savedPercent };
  }

  /**
   * #2 Think in Code Comparison — ratio of file size to sandbox output size.
   *
   * Stub: requires server.ts tracking of execute/execute_file calls.
   */
  static thinkInCodeComparison(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
    const ratio = outputBytes > 0
      ? Math.round((fileBytes / outputBytes) * 10) / 10
      : 0;
    return { fileBytes, outputBytes, ratio };
  }

  /**
   * #3 Tool Savings — per-tool breakdown of context savings.
   *
   * Stub: requires per-tool accumulators in server.ts.
   */
  static toolSavings(
    tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>,
  ): ToolSavingsRow[] {
    return tools.map((t) => ({
      ...t,
      savedBytes: t.rawBytes - t.contextBytes,
    }));
  }

  /**
   * #19 Sandbox I/O — total input/output bytes processed by the sandbox.
   *
   * Stub: requires PolyglotExecutor byte counters.
   */
  static sandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
    return { inputBytes, outputBytes };
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 4 — New Extractor Needed (3 metrics)
  // ═══════════════════════════════════════════════════════

  /**
   * #6 Pattern Detected — identifies recurring patterns in a session.
   *
   * Analyzes category distribution and detects dominant patterns
   * (>60% threshold). Falls back to combination detection and
   * "balanced" for evenly distributed sessions.
   */
  patternDetected(sessionId: string): string {
    const categories = this.sessionContinuity(sessionId);
    const total = categories.reduce((sum, c) => sum + c.count, 0);
    if (total === 0) return "no activity";

    // Sort by count descending
    categories.sort((a, b) => b.count - a.count);
    const dominant = categories[0];
    const ratio = dominant.count / total;

    if (ratio > 0.6) {
      const patterns: Record<string, string> = {
        file: "heavy file editor",
        git: "git-focused",
        mcp: "tool-heavy",
        error: "debugging session",
        plan: "planning session",
        subagent: "delegation-heavy",
        rule: "configuration session",
        task: "task management",
      };
      return patterns[dominant.category] ?? `${dominant.category}-focused`;
    }

    // Check for common combinations
    if (
      categories.find((c) => c.category === "git") &&
      categories.find((c) => c.category === "file")
    ) {
      return "build and commit";
    }
    return "balanced";
  }

  /**
   * #21 Permission Denials — count of tool calls blocked by security rules.
   *
   * Filters error events containing "denied", "blocked", or "permission".
   * Stub: ideally requires a dedicated extractor in extract.ts.
   */
  permissionDenials(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'error'
         AND (data LIKE '%denied%' OR data LIKE '%blocked%' OR data LIKE '%permission%')`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  // ═══════════════════════════════════════════════════════
  // queryAll — single unified report from ONE source
  // ═══════════════════════════════════════════════════════

  /**
   * Build a complete FullReport by merging runtime stats (passed in)
   * with all 27 DB-backed metrics and continuity data.
   *
   * This is the ONE call that ctx_stats should use.
   */
  queryAll(runtimeStats: RuntimeStats): FullReport {
    // ── Resolve latest session ID ──
    const latestSession = this.db.prepare(
      "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { session_id: string } | undefined;
    const sid = latestSession?.session_id ?? "";

    // ── Runtime savings ──
    const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce(
      (sum, b) => sum + b, 0,
    );
    const totalCalls = Object.values(runtimeStats.calls).reduce(
      (sum, c) => sum + c, 0,
    );
    const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0
      ? Math.round((1 - totalBytesReturned / totalProcessed) * 100)
      : 0;

    const toolNames = new Set([
      ...Object.keys(runtimeStats.calls),
      ...Object.keys(runtimeStats.bytesReturned),
    ]);
    const byTool = Array.from(toolNames).sort().map((tool) => ({
      tool,
      calls: runtimeStats.calls[tool] || 0,
      context_kb: Math.round((runtimeStats.bytesReturned[tool] || 0) / 1024 * 10) / 10,
      tokens: Math.round((runtimeStats.bytesReturned[tool] || 0) / 4),
    }));

    const uptimeMs = Date.now() - runtimeStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // ── Cache ──
    let cache: FullReport["cache"];
    if (runtimeStats.cacheHits > 0 || runtimeStats.cacheBytesSaved > 0) {
      const totalWithCache = totalProcessed + runtimeStats.cacheBytesSaved;
      const totalSavingsRatio = totalWithCache / Math.max(totalBytesReturned, 1);
      const ttlHoursLeft = Math.max(0, 24 - Math.floor((Date.now() - runtimeStats.sessionStart) / (60 * 60 * 1000)));
      cache = {
        hits: runtimeStats.cacheHits,
        bytes_saved: runtimeStats.cacheBytesSaved,
        ttl_hours_left: ttlHoursLeft,
        total_with_cache: totalWithCache,
        total_savings_ratio: totalSavingsRatio,
      };
    }

    // ── Session metrics ──
    const durationMin = sid ? this.sessionDuration(sid) : null;
    const toolCallsDb = sid ? (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'mcp'",
    ).get(sid) as { cnt: number }).cnt : 0;

    // ── Activity metrics ──
    const commits = sid ? this.commitCount(sid) : 0;
    const errors = sid ? this.errorCount(sid) : 0;
    const errorRatePct = sid ? this.errorRate(sid) : 0;
    const toolDiversity = sid ? this.toolDiversity(sid) : 0;
    const effScore = sid ? this.efficiencyScore(sid) : 0;
    const commitsPerSessionAvg = this.commitsPerSession();
    const sessionOutcome = sid ? this.sessionOutcome(sid) : "exploratory";
    const mix = this.sessionMix();

    // ── Pattern metrics ──
    const hourlyRaw = this.hourlyProductivity(sid || undefined);
    const hourlyCommits = Array.from({ length: 24 }, (_, i) => {
      const h = String(i).padStart(2, "0");
      return hourlyRaw.find((r) => r.hour === h)?.count ?? 0;
    });
    const weeklyTrend = this.weeklyTrend();
    const iterCycles = sid ? this.iterationCycles(sid) : 0;
    const rework = sid ? this.reworkRate(sid) : this.reworkRate();

    // ── Health metrics ──
    const claudeMdFreshness = this.claudeMdFreshness().map((r) => {
      const daysAgo = r.last_updated
        ? Math.round((Date.now() - new Date(r.last_updated).getTime()) / 86_400_000)
        : null;
      return { project: r.data, days_ago: daysAgo };
    });
    const compactionsThisWeek = sid ? this.compactionCount(sid) : 0;
    const weeklySessions = this.weeklySessionCount();
    const permDenials = sid ? this.permissionDenials(sid) : 0;

    // ── Agent metrics ──
    const subagents = sid
      ? this.subagentUsage(sid).map((r) => ({ type: r.data, count: r.total }))
      : [];
    const skills = sid
      ? this.skillUsage(sid).map((r) => ({ name: r.data, count: r.invocations }))
      : [];

    // ── Continuity data ──
    const eventTotal = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events",
    ).get() as { cnt: number }).cnt;

    const byCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
    ).all() as Array<{ category: string; cnt: number }>;

    const meta = this.db.prepare(
      "SELECT compact_count FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db.prepare(
      "SELECT event_count, consumed FROM session_resume ORDER BY created_at DESC LIMIT 1",
    ).get() as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // Build category previews
    const previewRows = this.db.prepare(
      "SELECT category, type, data FROM session_events ORDER BY id DESC",
    ).all() as Array<{ category: string; type: string; data: string }>;

    const previews = new Map<string, Set<string>>();
    for (const row of previewRows) {
      if (!previews.has(row.category)) previews.set(row.category, new Set());
      const set = previews.get(row.category)!;
      if (set.size < 5) {
        let display = row.data;
        if (row.category === "file") {
          display = row.data.split("/").pop() || row.data;
        } else if (row.category === "prompt") {
          display = display.length > 50 ? display.slice(0, 47) + "..." : display;
        }
        if (display.length > 40) display = display.slice(0, 37) + "...";
        set.add(display);
      }
    }

    const continuityByCategory = byCategory.map((row) => ({
      category: row.category,
      count: row.cnt,
      label: categoryLabels[row.category] || row.category,
      preview: previews.get(row.category)
        ? Array.from(previews.get(row.category)!).join(", ")
        : "",
      why: categoryHints[row.category] || "Survives context resets",
    }));

    return {
      savings: {
        processed_kb: Math.round(totalProcessed / 1024 * 10) / 10,
        entered_kb: Math.round(totalBytesReturned / 1024 * 10) / 10,
        saved_kb: Math.round(keptOut / 1024 * 10) / 10,
        pct: reductionPct,
        savings_ratio: Math.round(savingsRatio * 10) / 10,
        by_tool: byTool,
        total_calls: totalCalls,
        total_bytes_returned: totalBytesReturned,
        kept_out: keptOut,
        total_processed: totalProcessed,
      },
      cache,
      session: {
        id: sid,
        duration_min: durationMin !== null ? Math.round(durationMin * 10) / 10 : null,
        tool_calls: toolCallsDb,
        uptime_min: uptimeMin,
      },
      activity: {
        commits,
        errors,
        error_rate_pct: errorRatePct,
        tool_diversity: toolDiversity,
        efficiency_score: effScore,
        commits_per_session_avg: commitsPerSessionAvg,
        session_outcome: sessionOutcome,
        productive_pct: mix.productive,
        exploratory_pct: mix.exploratory,
      },
      patterns: {
        hourly_commits: hourlyCommits,
        weekly_trend: weeklyTrend,
        iteration_cycles: iterCycles,
        rework: rework.map((r) => ({ file: r.data, edits: r.edits })),
      },
      health: {
        claude_md_freshness: claudeMdFreshness,
        compactions_this_week: compactionsThisWeek,
        weekly_sessions: weeklySessions,
        permission_denials: permDenials,
      },
      agents: { subagents, skills },
      continuity: {
        total_events: eventTotal,
        by_category: continuityByCategory,
        compact_count: compactCount,
        resume_ready: resumeReady,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// formatReport — renders FullReport as markdown
// ─────────────────────────────────────────────────────────

/** Format bytes as human-readable KB or MB. */
function kb(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024).toFixed(1)}KB`;
}

/**
 * Render a FullReport as a marketing-friendly, outcome-focused session story.
 *
 * Framework: Persona -> Metric -> Evidence -> Action -> ROI
 * The output tells a narrative instead of dumping raw numbers.
 */
export function formatReport(report: FullReport): string {
  const lines: string[] = [];

  // ── Hero: headline story ──
  lines.push(`## Think in Code -- Session Report`);

  if (report.savings.total_calls === 0) {
    lines.push(
      "",
      "No sandbox activity yet. Use ctx_execute or ctx_batch_execute to start saving context.",
      "",
      "---",
      "_Display this entire report as-is in your response. Do NOT summarize, collapse, or paraphrase any section._",
    );
    return lines.join("\n");
  }

  const totalProcessed =
    report.savings.kept_out + (report.cache ? report.cache.bytes_saved : 0);
  const totalReturned = report.savings.total_bytes_returned;
  const grandTotal = totalProcessed + totalReturned;
  const savingsPercent =
    grandTotal > 0
      ? ((1 - totalReturned / grandTotal) * 100).toFixed(1)
      : "0.0";
  // Rough estimate: 4 bytes per token, ~2 min reading time per 1000 tokens
  const tokensSaved = Math.round(totalProcessed / 4);
  const extraMinutes = Math.round((tokensSaved / 1000) * 2);

  lines.push(
    "",
    `Your agent processed ${kb(totalProcessed)} of data.`,
    `Only ${kb(totalReturned)} entered your context window.`,
    "",
    `**Context saved: ${savingsPercent}% -- session extended by ~${extraMinutes} minutes**`,
  );

  // ── What happened ──
  lines.push("", "### What happened", "");

  // Count per-tool categories
  const toolCallMap = new Map<string, number>();
  for (const t of report.savings.by_tool) {
    toolCallMap.set(t.tool, t.calls);
  }

  const executeCount =
    (toolCallMap.get("ctx_execute") ?? 0) +
    (toolCallMap.get("ctx_execute_file") ?? 0);
  const batchCount = toolCallMap.get("ctx_batch_execute") ?? 0;
  const searchCount = toolCallMap.get("ctx_search") ?? 0;
  const fetchCount = toolCallMap.get("ctx_fetch_and_index") ?? 0;
  const fileCount = executeCount + batchCount;
  const networkCount = fetchCount;
  const cacheCount = report.cache ? report.cache.hits : 0;

  if (fileCount > 0) {
    lines.push(
      `-> ${fileCount} file${fileCount !== 1 ? "s" : ""} analyzed in sandbox (never entered context)`,
    );
  }
  if (networkCount > 0) {
    lines.push(
      `-> ${networkCount} API call${networkCount !== 1 ? "s" : ""} sandboxed (responses indexed, not dumped)`,
    );
  }
  if (searchCount > 0) {
    lines.push(
      `-> ${searchCount} search quer${searchCount !== 1 ? "ies" : "y"} served from index`,
    );
  }
  if (cacheCount > 0) {
    lines.push(
      `-> ${cacheCount} repeat fetch${cacheCount !== 1 ? "es" : ""} avoided (TTL cache)`,
    );
  }

  // ── Per-tool breakdown ──
  const activatedTools = report.savings.by_tool.filter((t) => t.calls > 0);
  if (activatedTools.length > 0) {
    lines.push(
      "",
      "### Per-tool breakdown",
      "",
      "| Tool | Calls | Data processed | Context used | Saved |",
      "|------|------:|---------------:|-------------:|------:|",
    );
    for (const t of activatedTools) {
      const processed = t.tokens * 4; // bytes approximation from tokens
      const contextUsed = t.context_kb * 1024;
      const savedPct =
        processed > 0
          ? (
              ((processed - contextUsed) / processed) *
              100
            ).toFixed(0)
          : "--";
      lines.push(
        `| ${t.tool} | ${t.calls} | ${kb(processed)} | ${kb(contextUsed)} | ${savedPct}% |`,
      );
    }
  }

  // ── Session continuity ──
  if (report.continuity.total_events > 0) {
    lines.push("", "### Session continuity", "");
    const parts: string[] = [];
    if (report.continuity.compact_count > 0) {
      parts.push(
        `${report.continuity.compact_count} compaction${report.continuity.compact_count !== 1 ? "s" : ""}`,
      );
    }
    parts.push(
      `${report.continuity.total_events} event${report.continuity.total_events !== 1 ? "s" : ""} preserved`,
    );

    // Count tasks from continuity categories
    const taskRow = report.continuity.by_category.find(
      (c) => c.category === "task" || c.category === "tasks",
    );
    if (taskRow && taskRow.count > 0) {
      parts.push(
        `${taskRow.count} task${taskRow.count !== 1 ? "s" : ""} tracked`,
      );
    }

    lines.push(parts.join(" | "));

    if (report.continuity.compact_count > 0) {
      lines.push(
        "",
        `Session knowledge preserved across ${report.continuity.compact_count} compaction${report.continuity.compact_count !== 1 ? "s" : ""} -- zero context lost.`,
      );
    } else {
      lines.push(
        "",
        "When your context compacts, all of this will restore awareness -- no starting from scratch.",
      );
    }
    if (report.continuity.resume_ready) {
      lines.push("Resume snapshot ready for the next compaction.");
    }
  }

  // ── Analytics JSON (for power users) ──
  const analyticsJson = {
    session: {
      duration_min: report.session.duration_min,
      tool_calls: report.session.tool_calls,
    },
    activity: {
      commits: report.activity.commits,
      errors: report.activity.errors,
      error_rate_pct: report.activity.error_rate_pct,
      tool_diversity: report.activity.tool_diversity,
      efficiency_score: report.activity.efficiency_score,
      commits_per_session_avg: report.activity.commits_per_session_avg,
      session_outcome: report.activity.session_outcome,
    },
    patterns: {
      hourly_commits: report.patterns.hourly_commits,
      weekly_trend: report.patterns.weekly_trend,
      iteration_cycles: report.patterns.iteration_cycles,
      rework: report.patterns.rework,
    },
    health: {
      claude_md_freshness: report.health.claude_md_freshness,
      compactions_this_week: report.health.compactions_this_week,
      weekly_sessions: report.health.weekly_sessions,
      permission_denials: report.health.permission_denials,
    },
    agents: {
      subagents: report.agents.subagents,
      skills: report.agents.skills,
    },
    continuity: { total_events: report.continuity.total_events },
  };

  lines.push(
    "",
    "### Analytics (27 metrics)",
    "",
    "```json",
    JSON.stringify(analyticsJson, null, 2),
    "```",
  );

  // Footer
  lines.push(
    "",
    "---",
    "context-mode -- github.com/mksglu/context-mode",
    "",
    "_Display this entire report as-is in your response. Do NOT summarize, collapse, or paraphrase any section._",
  );

  return lines.join("\n");
}
