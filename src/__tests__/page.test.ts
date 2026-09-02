// FILE: src/__tests__/page.test.ts
// VERSION: 1.2.0

import { describeJobRun } from "../app/page";
import { getStaleThresholdMs } from "../lib/jobRun";
import type { JobRunSummary, SettingsRow } from "../lib/jobRun";

// page.tsx pulls in ../lib/db transitively (directly, and via ../lib/jobRun); describeJobRun
// itself never touches prisma, but the module must still import cleanly under test.
jest.mock("../lib/db", () => ({
    prisma: {},
}));

function makeRun(overrides: Partial<JobRunSummary> = {}): JobRunSummary {
    return {
        job: "library",
        startedAt: new Date(),
        finishedAt: new Date(),
        ok: true,
        processed: 0,
        error: null,
        ...overrides,
    };
}

// Default-shaped settings row (matches prisma/schema.prisma's @default values) for computing
// real per-job thresholds via getStaleThresholdMs, cast through unknown since the real Settings
// type carries many unrelated required fields (credentials, etc.) this test never needs.
function makeSettings(overrides: Record<string, unknown> = {}): SettingsRow {
    return {
        checkInterval: 15,
        watchlistIntervalHours: 12,
        freePromosIntervalHours: 1,
        freePromosStartHour: 9,
        freePromosEndHour: 23,
        achievementIntervalHours: 6,
        achievementStartHour: 9,
        achievementEndHour: 23,
        ...overrides,
    } as unknown as SettingsRow;
}

describe("M-UI: describeJobRun", () => {
    it("treats an unresolved run (ok === null) as stale even when it just started", () => {
        // A huge staleAfterMs proves the "stale" verdict here comes from ok === null, not from
        // elapsed time — the exact crash-loop scenario the health-endpoint fix addresses.
        const run = makeRun({ ok: null, finishedAt: null, startedAt: new Date() });

        const row = describeJobRun("library", run, 999_999_999, true);

        expect(row.status).toBe("stale");
    });

    it("reports never for a known job absent from the run list", () => {
        const row = describeJobRun("achievements", undefined, 999_999_999, true);

        expect(row.status).toBe("never");
        expect(row.title).toBe("Достижения");
    });

    it("reports failing for ok === false regardless of the staleness window", () => {
        const run = makeRun({ ok: false, error: "Steam API error: 503" });

        const row = describeJobRun("watchlist", run, 0, true);

        expect(row.status).toBe("failing");
        expect(row.error).toBe("Steam API error: 503");
    });

    it("does not flag a windowed job as stale for a gap inside its own daily off-window", () => {
        // free-promos defaults: interval 1h, window 09:00-23:00 -> off-window 9h, threshold
        // (1*3 + 9)h = 12h. A run 5 hours old (e.g. last ran 23:00, now 04:00) must read "ok",
        // not "stale" — the every-night false alarm this rule exists to prevent.
        const settings = makeSettings();
        const run = makeRun({ job: "free-promos", startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) });

        const row = describeJobRun("free-promos", run, getStaleThresholdMs("free-promos", settings), true);

        expect(row.status).toBe("ok");
    });

    it("flags the same windowed job as stale once it exceeds interval + off-window", () => {
        const settings = makeSettings();
        const run = makeRun({ job: "free-promos", startedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) });

        const row = describeJobRun("free-promos", run, getStaleThresholdMs("free-promos", settings), true);

        expect(row.status).toBe("stale");
    });

    it("judges each job by its own threshold, not a shared one", () => {
        // watchlist default threshold is 3 * 12h = 36h; silent for over 36h must read stale.
        // library default threshold is 3 * 15min = 45min; a fresh 5-minute-old run must read ok.
        // Using the wrong (shared) threshold for either job would flip one of these verdicts.
        const settings = makeSettings();

        const staleWatchlist = makeRun({ job: "watchlist", startedAt: new Date(Date.now() - 37 * 60 * 60 * 1000) });
        const freshLibrary = makeRun({ job: "library", startedAt: new Date(Date.now() - 5 * 60 * 1000) });

        const watchlistRow = describeJobRun("watchlist", staleWatchlist, getStaleThresholdMs("watchlist", settings), true);
        const libraryRow = describeJobRun("library", freshLibrary, getStaleThresholdMs("library", settings), true);

        expect(watchlistRow.status).toBe("stale");
        expect(libraryRow.status).toBe("ok");
    });

    it("renders a disabled job as off, not stale, no matter how long it has been silent", () => {
        // 200 hours silent would be well past watchlist's own 36h threshold if it were enabled —
        // proving "off" wins over "stale" rather than the elapsed time being checked at all.
        const run = makeRun({ job: "watchlist", startedAt: new Date(Date.now() - 200 * 60 * 60 * 1000), ok: true });

        const row = describeJobRun("watchlist", run, getStaleThresholdMs("watchlist", makeSettings()), false);

        expect(row.status).toBe("off");
        expect(row.timeLabel).not.toBe("ещё ни разу не запускалась");
    });

    it("still distinguishes off from never (enabled, no row yet)", () => {
        const offRow = describeJobRun("watchlist", undefined, 999_999_999, false);
        const neverRow = describeJobRun("watchlist", undefined, 999_999_999, true);

        expect(offRow.status).toBe("off");
        expect(neverRow.status).toBe("never");
        expect(offRow.status).not.toBe(neverRow.status);
    });
});
