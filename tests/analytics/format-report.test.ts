/**
 * formatReport — Tests for the savings-first ctx_stats output.
 *
 * Design rules under test:
 * 1. Fresh session (totalKeptOut === 0) shows honest "no savings yet" format
 * 2. Active session shows hero metric: tokens saved with percentage
 * 3. Savings bar visualizes the savings ratio
 * 4. Per-tool table only shown when 2+ different tools called
 * 5. Per-tool table sorted by estimated saved (highest first)
 * 6. Session memory reframed as value prop
 * 7. Under 25 lines for heavy sessions
 * 8. Version and update info in footer
 */

import { describe, it, expect } from "vitest";
import { formatReport, type FullReport } from "../../src/session/analytics.js";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeReport(overrides: Partial<FullReport> = {}): FullReport {
  return {
    savings: {
      processed_kb: 0,
      entered_kb: 0,
      saved_kb: 0,
      pct: 0,
      savings_ratio: 0,
      by_tool: [],
      total_calls: 0,
      total_bytes_returned: 0,
      kept_out: 0,
      total_processed: 0,
    },
    session: {
      id: "test-session",
      uptime_min: "2.0",
    },
    continuity: {
      total_events: 0,
      by_category: [],
      compact_count: 0,
      resume_ready: false,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

describe("formatReport", () => {
  describe("fresh session (no savings)", () => {
    it("shows no tool calls message when zero calls", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("Context Mode -- Session");
      expect(output).toContain("No tool calls yet.");
      expect(output).toContain("Tip:");
      expect(output).toContain("v1.0.71");
    });

    it("shows call count and zero tokens saved when calls exist but no savings", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 1,
          total_bytes_returned: 3891,
          kept_out: 0,
          by_tool: [
            { tool: "ctx_stats", calls: 1, context_kb: 3.8, tokens: 973 },
          ],
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("1 call");
      expect(output).toContain("in context");
      expect(output).toContain("0 tokens saved");
      // Should NOT show savings bar or token savings header
      expect(output).not.toContain("Token Savings");
    });

    it("does not show fake percentages for fresh session", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 2,
          total_bytes_returned: 1600,
          kept_out: 0,
        },
      });
      const output = formatReport(report);

      expect(output).not.toMatch(/\d+\.\d+%/);
      expect(output).toContain("0 tokens saved");
    });
  });

  describe("active session (savings dashboard)", () => {
    it("shows hero metrics: total calls, data processed, tokens saved", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 16,
          total_bytes_returned: 3277,
          kept_out: 536576, // 524 KB
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.1, tokens: 282 },
            { tool: "ctx_execute", calls: 3, context_kb: 0.8, tokens: 205 },
            { tool: "ctx_search", calls: 8, context_kb: 1.3, tokens: 333 },
          ],
        },
        continuity: {
          total_events: 47,
          by_category: [],
          compact_count: 3,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("Token Savings");
      expect(output).toContain("Total calls:");
      expect(output).toContain("16");
      expect(output).toContain("Data processed:");
      expect(output).toContain("Tokens saved:");
      expect(output).toContain("Saved:");
      expect(output).toContain("v1.0.71");
    });

    it("shows savings bar with percentage", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 8000, // 80%
        },
      });
      const output = formatReport(report);

      // Should contain the savings bar line
      expect(output).toContain("Saved:");
      expect(output).toMatch(/80\.0%/);
      // Bar should contain unicode block characters
      expect(output).toMatch(/[\u2588\u2591]/);
    });

    it("shows per-tool table when 2+ tools used, sorted by saved", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 8,
          total_bytes_returned: 2000,
          kept_out: 50000,
          by_tool: [
            { tool: "ctx_execute", calls: 3, context_kb: 0.8, tokens: 205 },
            { tool: "ctx_batch_execute", calls: 5, context_kb: 1.1, tokens: 282 },
          ],
        },
      });
      const output = formatReport(report);

      expect(output).toContain("ctx_batch_execute");
      expect(output).toContain("ctx_execute");
      expect(output).toContain("Tool");
      expect(output).toContain("Calls");
      expect(output).toContain("Saved");

      // batch_execute has more context_kb so more estimated saved - should be first
      const lines = output.split("\n");
      const batchLine = lines.findIndex((l) => l.includes("ctx_batch_execute"));
      const execLine = lines.findIndex((l) => l.includes("ctx_execute"));
      expect(batchLine).toBeLessThan(execLine);
    });

    it("does NOT show per-tool table when only 1 tool used", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 2000,
          kept_out: 50000,
          by_tool: [
            { tool: "ctx_batch_execute", calls: 5, context_kb: 2.0, tokens: 512 },
          ],
        },
      });
      const output = formatReport(report);

      // Should not show tool table header
      expect(output).not.toMatch(/^#\s+Tool/m);
    });

    it("includes cache savings in totalKeptOut", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 10000,
        },
        cache: {
          hits: 3,
          bytes_saved: 5000,
          ttl_hours_left: 20,
          total_with_cache: 16000,
          total_savings_ratio: 16,
        },
      });
      const output = formatReport(report);

      // totalKeptOut = 10000 + 5000 = 15000, grandTotal = 16000
      // savingsPct = 15000/16000 = 93.75%
      expect(output).toContain("93.8%");
      expect(output).toContain("Cache hits:");
      expect(output).toContain("3");
    });

    it("tokens saved uses K/M suffixes for large numbers", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 100,
          total_bytes_returned: 4_000_000,
          kept_out: 25_000_000,
        },
      });
      const output = formatReport(report);

      // 25MB / 4 bytes per token = 6.25M tokens
      expect(output).toMatch(/6\.3M/);
    });
  });

  describe("session memory", () => {
    it("shows session memory with category breakdown", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
        continuity: {
          total_events: 25,
          by_category: [
            { category: "file", count: 12, label: "Files tracked", preview: "server.ts, db.ts, utils.ts", why: "Restored after compact" },
            { category: "git", count: 5, label: "Git operations", preview: "feat: add analytics", why: "Branch state preserved" },
            { category: "decision", count: 4, label: "Your decisions", preview: "Use vitest for testing", why: "Applied automatically" },
            { category: "task", count: 4, label: "Tasks in progress", preview: "Implement session continuity", why: "Picks up from where it stopped" },
          ],
          compact_count: 2,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("Session memory:");
      expect(output).toContain("25 events");
      expect(output).toContain("file 12");
      expect(output).toContain("git 5");
      expect(output).toContain("decision 4");
      expect(output).toContain("task 4");
    });

    it("shows compaction survival message when compactions > 0", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        continuity: {
          total_events: 47,
          by_category: [
            { category: "file", count: 30, label: "Files tracked", preview: "a.ts", why: "Restored" },
          ],
          compact_count: 3,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("Survived 3 compactions");
      expect(output).toContain("knowledge persists");
    });

    it("shows events tracked when no categories", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        continuity: {
          total_events: 47,
          by_category: [],
          compact_count: 0,
          resume_ready: false,
        },
      });
      const output = formatReport(report, "1.0.71");

      expect(output).toContain("47 events tracked");
    });

    it("hides session memory when no events", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 5,
          total_bytes_returned: 1000,
          kept_out: 50000,
        },
        continuity: {
          total_events: 0,
          by_category: [],
          compact_count: 0,
          resume_ready: false,
        },
      });
      const output = formatReport(report);

      expect(output).not.toContain("Session memory");
    });
  });

  describe("output constraints", () => {
    it("uses 'Context Mode' as name, not 'Think in Code'", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report);

      expect(output).toContain("Context Mode");
      expect(output).not.toContain("Think in Code");
    });

    it("does not include analytics JSON", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report);

      expect(output).not.toContain("```json");
    });

    it("active session with tools + continuity is under 25 lines", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 184,
          total_bytes_returned: 4_194_304,  // 4 MB
          kept_out: 26_314_342,             // ~25.1 MB
          by_tool: [
            { tool: "ctx_batch_execute", calls: 126, context_kb: 2800, tokens: 717_000 },
            { tool: "ctx_search", calls: 35, context_kb: 760, tokens: 194_560 },
            { tool: "ctx_execute", calls: 22, context_kb: 390, tokens: 99_840 },
            { tool: "ctx_fetch_and_index", calls: 1, context_kb: 50, tokens: 12_800 },
          ],
        },
        continuity: {
          total_events: 1109,
          by_category: [
            { category: "file", count: 554, label: "Files tracked", preview: "server.ts", why: "Restored" },
            { category: "subagent", count: 174, label: "Delegated work", preview: "research", why: "Preserved" },
            { category: "prompt", count: 122, label: "Requests saved", preview: "fix bug", why: "Continues" },
            { category: "rule", count: 96, label: "Project rules", preview: "CLAUDE.md", why: "Survives" },
            { category: "git", count: 89, label: "Git operations", preview: "main", why: "Preserved" },
            { category: "error", count: 35, label: "Errors caught", preview: "TypeError", why: "Tracked" },
          ],
          compact_count: 0,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");
      const lineCount = output.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(25);
    });

    it("fresh session output is under 10 lines", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");
      const lineCount = output.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(10);
    });
  });

  describe("version handling", () => {
    it("shows update warning when latestVersion differs", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report, "1.0.65", "1.0.70");
      expect(output).toContain("Update available");
      expect(output).toContain("v1.0.65 -> v1.0.70");
      expect(output).toContain("ctx_upgrade");
    });

    it("no update warning when version matches", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 10,
          total_bytes_returned: 2000,
          kept_out: 100000,
        },
      });
      const output = formatReport(report, "1.0.70", "1.0.70");
      expect(output).not.toContain("Update available");
    });

    it("shows update warning on fresh session too", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.65", "1.0.70");
      expect(output).toContain("Update available");
    });

    it("shows version when provided", () => {
      const report = makeReport();
      const output = formatReport(report, "1.0.71");
      expect(output).toContain("v1.0.71");
    });

    it("falls back to 'context-mode' when version not provided", () => {
      const report = makeReport();
      const output = formatReport(report);
      expect(output).toContain("context-mode");
    });
  });

  describe("duration formatting", () => {
    it("shows minutes for short sessions", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "2.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("(2 min)");
    });

    it("shows minutes for medium sessions", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "45.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("(45 min)");
    });

    it("shows hours format for 60+ minutes", () => {
      const report = makeReport({
        session: { ...makeReport().session, uptime_min: "90.0" },
      });
      const output = formatReport(report);
      expect(output).toContain("(1h 30m)");
    });
  });

  describe("realistic scenario: heavy session", () => {
    it("produces the expected output shape for a 184-call session", () => {
      const report = makeReport({
        savings: {
          ...makeReport().savings,
          total_calls: 184,
          total_bytes_returned: 4_194_304,  // 4 MB
          kept_out: 26_314_342,             // ~25.1 MB
          by_tool: [
            { tool: "ctx_batch_execute", calls: 126, context_kb: 2800, tokens: 717_000 },
            { tool: "ctx_search", calls: 35, context_kb: 760, tokens: 194_560 },
            { tool: "ctx_execute", calls: 22, context_kb: 390, tokens: 99_840 },
            { tool: "ctx_fetch_and_index", calls: 1, context_kb: 50, tokens: 12_800 },
          ],
        },
        cache: {
          hits: 3,
          bytes_saved: 524_288,
          ttl_hours_left: 18,
          total_with_cache: 31_032_934,
          total_savings_ratio: 7.4,
        },
        session: {
          id: "heavy-session",
          uptime_min: "306.0",
        },
        continuity: {
          total_events: 1109,
          by_category: [
            { category: "file", count: 554, label: "Files tracked", preview: "server.ts", why: "Restored" },
            { category: "subagent", count: 174, label: "Delegated work", preview: "research", why: "Preserved" },
            { category: "prompt", count: 122, label: "Requests saved", preview: "fix bug", why: "Continues" },
            { category: "rule", count: 96, label: "Project rules", preview: "CLAUDE.md", why: "Survives" },
            { category: "git", count: 89, label: "Git operations", preview: "main", why: "Preserved" },
            { category: "error", count: 35, label: "Errors caught", preview: "TypeError", why: "Tracked" },
          ],
          compact_count: 0,
          resume_ready: true,
        },
      });
      const output = formatReport(report, "1.0.71");

      // Key value props are present
      expect(output).toContain("Token Savings (5h 6m)");
      expect(output).toContain("184");
      expect(output).toContain("Tokens saved:");
      expect(output).toContain("Cache hits:");
      expect(output).toContain("Session memory:");
      expect(output).toContain("1.1K events");

      // Verify it's parseable (no garbled lines)
      const allLines = output.split("\n");
      for (const line of allLines) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    });
  });
});
