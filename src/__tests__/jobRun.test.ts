// FILE: src/__tests__/jobRun.test.ts
// VERSION: 1.2.0

import { prisma } from "../lib/db";
import { getLastRuns, getStaleThresholdMs, runTracked } from "../lib/jobRun";
import type { SettingsRow } from "../lib/jobRun";

jest.mock("../lib/db", () => ({
    prisma: {
        jobRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    },
}));

const prismaMock = prisma as unknown as {
    jobRun: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
};

// Default-shaped settings row (matches prisma/schema.prisma's @default values), cast through
// unknown since the real Settings type carries many unrelated required fields these tests never need.
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

describe("M-JOBRUN: every cron run leaves a trace", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        prismaMock.jobRun.create.mockResolvedValue({ id: 7 });
    });

    afterEach(() => jest.restoreAllMocks());

    it("records a successful run with the processed count", async () => {
        const result = await runTracked("library", async report => {
            report.processed = 3;
            return "done";
        });

        expect(result).toBe("done");
        expect(prismaMock.jobRun.create).toHaveBeenCalledWith({ data: { job: "library" } });
        expect(prismaMock.jobRun.update).toHaveBeenCalledWith({
            where: { id: 7 },
            data: expect.objectContaining({ ok: true, processed: 3, error: null, finishedAt: expect.any(Date) }),
        });
    });

    it("records a failed run and swallows the error so the cron survives", async () => {
        const result = await runTracked("watchlist", async () => {
            throw new Error("Steam API error: 503");
        });

        expect(result).toBeNull();
        expect(prismaMock.jobRun.update).toHaveBeenCalledWith({
            where: { id: 7 },
            data: expect.objectContaining({ ok: false, error: expect.stringContaining("503") }),
        });
    });

    it("truncates a huge error message", async () => {
        const result = await runTracked("achievements", async () => {
            throw new Error("x".repeat(5000));
        });

        expect(result).toBeNull();
        const written = prismaMock.jobRun.update.mock.calls[0][0].data.error as string;
        expect(written.length).toBeLessThanOrEqual(1000);
    });

    it("keeps the partial processed count in the failure row when a job increments it before throwing", async () => {
        const result = await runTracked("free-promos", async report => {
            report.processed = 2;
            throw new Error("network blip");
        });

        expect(result).toBeNull();
        expect(prismaMock.jobRun.update).toHaveBeenCalledWith({
            where: { id: 7 },
            data: expect.objectContaining({ ok: false, processed: 2, error: expect.stringContaining("network blip") }),
        });
    });

    it("still runs the job and resolves when opening the run record fails", async () => {
        prismaMock.jobRun.create.mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
        const callback = jest.fn(async () => "still ran");

        const result = await runTracked("library", callback);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(result).toBe("still ran");
        expect(prismaMock.jobRun.update).not.toHaveBeenCalled();
    });

    it("looks up each known job individually and skips jobs that have never run", async () => {
        const libraryRun = { job: "library", startedAt: new Date("2026-09-01T10:00:00Z"), finishedAt: new Date("2026-09-01T10:00:20Z"), ok: true, processed: 2, error: null };
        const watchlistRun = { job: "watchlist", startedAt: new Date("2026-09-01T06:00:00Z"), finishedAt: null, ok: null, processed: 0, error: null };

        prismaMock.jobRun.findFirst.mockImplementation((args: { where: { job: string } }) => {
            if (args.where.job === "library") return Promise.resolve(libraryRun);
            if (args.where.job === "watchlist") return Promise.resolve(watchlistRun);
            return Promise.resolve(null); // free-promos and achievements have never run
        });

        const runs = await getLastRuns();

        expect(runs).toHaveLength(2);
        expect(runs).toContainEqual(expect.objectContaining({ job: "library", processed: 2 }));
        expect(runs).toContainEqual(expect.objectContaining({ job: "watchlist", ok: null }));
        expect(prismaMock.jobRun.findFirst).toHaveBeenCalledWith({ where: { job: "library" }, orderBy: { startedAt: "desc" } });
        expect(prismaMock.jobRun.findFirst).toHaveBeenCalledWith({ where: { job: "watchlist" }, orderBy: { startedAt: "desc" } });
        expect(prismaMock.jobRun.findFirst).toHaveBeenCalledWith({ where: { job: "free-promos" }, orderBy: { startedAt: "desc" } });
        expect(prismaMock.jobRun.findFirst).toHaveBeenCalledWith({ where: { job: "achievements" }, orderBy: { startedAt: "desc" } });
    });

    it("finds a low-frequency job's run even when a high-frequency job's rows would fill a shared 100-row window", async () => {
        // This pins the regression: a windowed `findMany({ orderBy: { startedAt: "desc" }, take: 100 })`
        // plus de-dup would see only these 100 fresh `library` rows and never reach `watchlist`'s single,
        // much older run. `findMany` is seeded here specifically so that a reversion back to the windowed
        // implementation fails this test, even though the current implementation never calls it.
        const freshLibraryRows = Array.from({ length: 100 }, (_, i) => ({
            job: "library",
            startedAt: new Date(Date.now() - i * 60_000),
            finishedAt: new Date(Date.now() - i * 60_000 + 1000),
            ok: true,
            processed: 1,
            error: null,
        }));
        prismaMock.jobRun.findMany.mockResolvedValue(freshLibraryRows);

        const oldWatchlistRun = {
            job: "watchlist",
            startedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
            finishedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000 + 1000),
            ok: true,
            processed: 5,
            error: null,
        };

        prismaMock.jobRun.findFirst.mockImplementation((args: { where: { job: string } }) => {
            if (args.where.job === "library") return Promise.resolve(freshLibraryRows[0]);
            if (args.where.job === "watchlist") return Promise.resolve(oldWatchlistRun);
            return Promise.resolve(null);
        });

        const runs = await getLastRuns();
        const jobs = runs.map(run => run.job);

        expect(jobs).toContain("library");
        expect(jobs).toContain("watchlist");
    });
});

describe("M-JOBRUN: getStaleThresholdMs — per-job staleness threshold", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const MINUTE_MS = 60 * 1000;

    it("computes library's threshold from checkInterval alone (minutes, no daily window)", () => {
        // 15 min * 3 = 45 min
        expect(getStaleThresholdMs("library", makeSettings({ checkInterval: 15 }))).toBe(45 * MINUTE_MS);
    });

    it("computes watchlist's threshold from watchlistIntervalHours alone (runs around the clock)", () => {
        // 12h * 3 = 36h
        expect(getStaleThresholdMs("watchlist", makeSettings({ watchlistIntervalHours: 12 }))).toBe(36 * HOUR_MS);
    });

    it("adds the off-window length to free-promos' threshold, derived only from start/end hour", () => {
        // interval 1h * 3 = 3h; window 09:00-23:00 is 15h active, so off-window = 24 - 15 = 9h;
        // threshold = (3 + 9)h = 12h. This is the exact scenario from the ruling: a job that last
        // ran at 23:00 and is checked again at 04:00 (5h later) must not be flagged stale.
        const settings = makeSettings({ freePromosIntervalHours: 1, freePromosStartHour: 9, freePromosEndHour: 23 });
        expect(getStaleThresholdMs("free-promos", settings)).toBe(12 * HOUR_MS);
    });

    it("adds the off-window length to achievements' threshold the same way, from its own hours", () => {
        // interval 6h * 3 = 18h; window 09:00-23:00 -> off-window 9h; threshold = 27h.
        const settings = makeSettings({ achievementIntervalHours: 6, achievementStartHour: 9, achievementEndHour: 23 });
        expect(getStaleThresholdMs("achievements", settings)).toBe(27 * HOUR_MS);
    });

    it("shrinks the off-window term for a narrower daily window", () => {
        // window 12:00-15:00 (3h active) -> off-window = 24 - 3 = 21h; interval 1h * 3 = 3h;
        // threshold = 24h. Proves the term is derived purely from the configured hours, not a
        // fixed constant.
        const settings = makeSettings({ freePromosIntervalHours: 1, freePromosStartHour: 12, freePromosEndHour: 14 });
        expect(getStaleThresholdMs("free-promos", settings)).toBe(24 * HOUR_MS);
    });

    it("falls back to schema defaults when settings fields are missing", () => {
        // watchlistIntervalHours default 12h * 3 = 36h, with an otherwise-empty settings row.
        expect(getStaleThresholdMs("watchlist", makeSettings({ watchlistIntervalHours: undefined }))).toBe(36 * HOUR_MS);
    });
});
