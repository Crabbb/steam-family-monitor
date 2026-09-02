// FILE: src/__tests__/api.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";
import { findLatestPerfectAchievementForUser } from "../lib/achievements";
import { sendTestMessage } from "../lib/core";
import { POST as postAchievementTest } from "../app/api/achievements/test/route";
import { POST as postSettings } from "../app/api/settings/route";
import { POST as postUser } from "../app/api/users/route";
import { POST as postTestMessage } from "../app/api/test-message/route";

jest.mock("../lib/worker", () => ({
    startWorker: jest.fn(),
}));

jest.mock("../lib/db", () => ({
    prisma: {
        settings: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
        },
        user: {
            create: jest.fn(),
        },
        jobRun: {
            findFirst: jest.fn(),
        },
    },
}));

jest.mock("../lib/core", () => ({
    sendTestMessage: jest.fn(),
}));

jest.mock("../lib/achievements", () => ({
    findLatestPerfectAchievementForUser: jest.fn(),
}));

const prismaMock = prisma as unknown as {
    settings: {
        upsert: jest.Mock;
        findUnique: jest.Mock;
    };
    user: {
        create: jest.Mock;
    };
    jobRun: {
        findFirst: jest.Mock;
    };
};
const sendTestMessageMock = sendTestMessage as jest.MockedFunction<typeof sendTestMessage>;
const findLatestPerfectAchievementForUserMock = findLatestPerfectAchievementForUser as jest.MockedFunction<typeof findLatestPerfectAchievementForUser>;

function jsonRequest(body: Record<string, unknown>): Request {
    return new Request("http://localhost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// getLastRuns looks up each job individually via findFirst (never a windowed findMany), so the
// mock must answer per job name rather than return one fixed array for every call.
function mockJobRuns(rows: Partial<Record<string, { startedAt: Date; ok: boolean | null; error?: string | null }>>) {
    prismaMock.jobRun.findFirst.mockImplementation(async ({ where }: { where: { job: string } }) => {
        const row = rows[where.job];
        if (!row) return null;
        return {
            job: where.job,
            startedAt: row.startedAt,
            // A row with ok === null was opened but never closed (openRun ran, closeRun never
            // did), so it never got a finishedAt either — matches the real crash-mid-run shape.
            finishedAt: row.ok === null ? null : row.startedAt,
            ok: row.ok,
            processed: 0,
            error: row.error ?? null,
        };
    });
}

describe("M-API: route validation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("rejects invalid settings intervals before writing to the database", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "0",
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "checkInterval must be a positive integer" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("saves valid settings with a parsed numeric interval", async () => {
        prismaMock.settings.upsert.mockResolvedValueOnce({
            id: 1,
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: 15,
            libraryPollingEnabled: true,
            watchlistEnabled: true,
            watchlistIntervalHours: 12,
            watchlistMinDiscountPct: 1,
            freePromosEnabled: true,
            freePromosIntervalHours: 1,
            freePromosStartHour: 9,
            freePromosEndHour: 23,
            freePromosTimezone: "Europe/Samara",
            freePromosRegionRu: true,
            freePromosRegionKz: true,
            freePromosSkipOwnedByAll: true,
            freePromosSearchCount: 100,
            achievementMonitoringEnabled: true,
            achievementIntervalHours: 6,
            achievementStartHour: 9,
            achievementEndHour: 23,
            achievementTimezone: "Europe/Samara",
            achievementScanLimit: 1000,
            achievementFullScanIntervalHours: 24,
            achievementSteamHuntersEnabled: true,
            achievementTestUserId: 2,
        });

        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            libraryPollingEnabled: true,
            watchlistEnabled: true,
            watchlistIntervalHours: "12",
            watchlistMinDiscountPct: "1",
            freePromosEnabled: true,
            freePromosIntervalHours: "1",
            freePromosStartHour: "9",
            freePromosEndHour: "23",
            freePromosTimezone: "Europe/Samara",
            freePromosRegionRu: true,
            freePromosRegionKz: true,
            freePromosSkipOwnedByAll: true,
            freePromosSearchCount: "100",
            achievementMonitoringEnabled: true,
            achievementIntervalHours: "6",
            achievementStartHour: "9",
            achievementEndHour: "23",
            achievementTimezone: "Europe/Samara",
            achievementScanLimit: "1000",
            achievementFullScanIntervalHours: "24",
            achievementSteamHuntersEnabled: true,
            achievementTestUserId: "2",
        }));

        expect(res.status).toBe(200);
        expect(prismaMock.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                checkInterval: 15,
                libraryPollingEnabled: true,
                watchlistEnabled: true,
                watchlistIntervalHours: 12,
                watchlistMinDiscountPct: 1,
                freePromosEnabled: true,
                freePromosIntervalHours: 1,
                freePromosStartHour: 9,
                freePromosEndHour: 23,
                freePromosTimezone: "Europe/Samara",
                freePromosRegionRu: true,
                freePromosRegionKz: true,
                freePromosSkipOwnedByAll: true,
                freePromosSearchCount: 100,
                achievementMonitoringEnabled: true,
                achievementIntervalHours: 6,
                achievementStartHour: 9,
                achievementEndHour: 23,
                achievementTimezone: "Europe/Samara",
                achievementScanLimit: 1000,
                achievementFullScanIntervalHours: 24,
                achievementSteamHuntersEnabled: true,
                achievementTestUserId: 2,
            }),
            create: expect.objectContaining({ checkInterval: 15 }),
        }));
    });

    it("rejects invalid perfect achievement full-scan intervals before writing to the database", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            achievementMonitoringEnabled: true,
            achievementFullScanIntervalHours: "0",
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "achievementFullScanIntervalHours must be between 1 and 168" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("rejects invalid perfect achievement settings before writing to the database", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            achievementMonitoringEnabled: true,
            achievementIntervalHours: "0",
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "achievementIntervalHours must be between 1 and 24" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("rejects free promotion settings when both regions are disabled", async () => {
        const res = await postSettings(jsonRequest({
            steamApiKey: "steam",
            telegramToken: "token",
            telegramChatId: "chat",
            checkInterval: "15",
            freePromosEnabled: true,
            freePromosRegionRu: false,
            freePromosRegionKz: false,
        }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "at least one free promotions region must be enabled" });
        expect(prismaMock.settings.upsert).not.toHaveBeenCalled();
    });

    it("rejects blank user fields before writing to the database", async () => {
        const res = await postUser(jsonRequest({ name: " ", steamId: "" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "name and steamId are required" });
        expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it("maps duplicate Steam IDs to a client error", async () => {
        prismaMock.user.create.mockRejectedValueOnce({ code: "P2002" });

        const res = await postUser(jsonRequest({ name: "Alice", steamId: "76561198000000000" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "Steam ID already exists" });
    });

    it("rejects non-numeric test message user ids", async () => {
        const res = await postTestMessage(jsonRequest({ userId: "not-a-number" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "userId must be a positive integer" });
        expect(sendTestMessageMock).not.toHaveBeenCalled();
    });

    it("sends test messages for valid numeric user ids", async () => {
        sendTestMessageMock.mockResolvedValueOnce(undefined);

        const res = await postTestMessage(jsonRequest({ userId: "42" }));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ success: true });
        expect(sendTestMessageMock).toHaveBeenCalledWith(42);
    });

    it("rejects non-numeric perfect achievement test user ids", async () => {
        const res = await postAchievementTest(jsonRequest({ userId: "not-a-number" }));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "userId must be a positive integer" });
        expect(findLatestPerfectAchievementForUserMock).not.toHaveBeenCalled();
    });

    it("sends the latest perfect achievement test for valid numeric user ids", async () => {
        findLatestPerfectAchievementForUserMock.mockResolvedValueOnce({ appId: "20" } as Awaited<ReturnType<typeof findLatestPerfectAchievementForUser>>);

        const res = await postAchievementTest(jsonRequest({ userId: "2" }));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ success: true, appId: "20" });
        expect(findLatestPerfectAchievementForUserMock).toHaveBeenCalledWith(2, { sendMessage: true });
    });
});

// Default-shaped settings row (matches prisma/schema.prisma's @default values) so each health
// test only needs to override what it actually varies, instead of restating every field the
// per-job staleness rule now reads.
function makeSettings(overrides: Record<string, unknown> = {}) {
    return {
        checkInterval: 15,
        libraryPollingEnabled: true,
        watchlistEnabled: true,
        watchlistIntervalHours: 12,
        freePromosEnabled: true,
        freePromosIntervalHours: 1,
        freePromosStartHour: 9,
        freePromosEndHour: 23,
        achievementMonitoringEnabled: true,
        achievementIntervalHours: 6,
        achievementStartHour: 9,
        achievementEndHour: 23,
        ...overrides,
    };
}

// A comfortably-recent, successful run — used to keep the three jobs not under test unambiguously
// healthy, so a test can isolate exactly one job's behavior instead of tripping over the others'
// default-enabled, never-run staleness.
function recentOkRun(minutesAgo = 5) {
    return { startedAt: new Date(Date.now() - minutesAgo * 60 * 1000), ok: true as const };
}

describe("M-API: GET /api/health", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("reports stale when the library job has not run for three intervals", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: { startedAt: new Date(Date.now() - 60 * 60 * 1000), ok: true },
            watchlist: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        const res = await GET();
        const body = await res.json();

        expect(body.status).toBe("stale");
        expect(body.jobs.find((j: { job: string }) => j.job === "library").job).toBe("library");
    });

    it("reports failing when an enabled job errored", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: recentOkRun(),
            watchlist: { startedAt: new Date(), ok: false, error: "Steam API error: 503" },
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        const res = await GET();

        expect((await res.json()).status).toBe("failing");
    });

    it("never leaks credentials", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings({
            steamApiKey: "secret-key", telegramToken: "secret-token",
        }));
        mockJobRuns({});

        const { GET } = await import("../app/api/health/route");
        const text = JSON.stringify(await (await GET()).json());

        expect(text).not.toContain("secret-key");
        expect(text).not.toContain("secret-token");
    });

    it("does not go stale after a single missed tick", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: { startedAt: new Date(Date.now() - 16 * 60 * 1000), ok: true },
            watchlist: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("ok");
    });

    it("stays ok comfortably under the three-interval threshold", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: { startedAt: new Date(Date.now() - 44 * 60 * 1000), ok: true },
            watchlist: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("ok");
    });

    it("goes stale comfortably over the three-interval threshold", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: { startedAt: new Date(Date.now() - 46 * 60 * 1000), ok: true },
            watchlist: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("stale");
    });

    it("reports stale, not ok, when no job has ever run and library polling is enabled", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({});

        const { GET } = await import("../app/api/health/route");
        const body = await (await GET()).json();

        expect(body.status).toBe("stale");
        // jobs is built from the canonical job list, not from getLastRuns()'s (empty) result, so
        // an empty table still yields one entry per known job, in a stable order, run fields null.
        expect(body.jobs).toHaveLength(4);
        expect(body.jobs.map((j: { job: string }) => j.job)).toEqual(["library", "watchlist", "free-promos", "achievements"]);
        for (const job of body.jobs) {
            expect(job.startedAt).toBeNull();
            expect(job.finishedAt).toBeNull();
            expect(job.ok).toBeNull();
            expect(job.enabled).toBe(true);
        }
    });

    it("lists an enabled job with no row using null run fields, and moves the headline to stale", async () => {
        // The exact fresh-deployment case: watchlist has not had its first run yet, but is
        // enabled by default. The headline must say stale (round 2's rule), and — the fix this
        // round adds — the detail list must still name watchlist so a consumer can see why.
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
            // watchlist: intentionally left unmocked — findFirst resolves null, i.e. no row yet.
        });

        const { GET } = await import("../app/api/health/route");
        const body = await (await GET()).json();

        expect(body.status).toBe("stale");
        const watchlistEntry = body.jobs.find((j: { job: string }) => j.job === "watchlist");
        expect(watchlistEntry).toBeDefined();
        expect(watchlistEntry.startedAt).toBeNull();
        expect(watchlistEntry.finishedAt).toBeNull();
        expect(watchlistEntry.ok).toBeNull();
        expect(watchlistEntry.processed).toBeNull();
        expect(watchlistEntry.enabled).toBe(true);
    });

    it("lists a disabled job with no row as off, without moving the headline status", async () => {
        // Previously invisible two ways at once: absent from `jobs` (no row) AND, before round 3,
        // would have been judged the same as an alarming silence rather than a deliberate choice.
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings({ watchlistEnabled: false }));
        mockJobRuns({
            library: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
            // watchlist: unmocked and disabled — no row, not supposed to have one.
        });

        const { GET } = await import("../app/api/health/route");
        const body = await (await GET()).json();

        expect(body.status).toBe("ok");
        const watchlistEntry = body.jobs.find((j: { job: string }) => j.job === "watchlist");
        expect(watchlistEntry).toBeDefined();
        expect(watchlistEntry.startedAt).toBeNull();
        expect(watchlistEntry.ok).toBeNull();
        expect(watchlistEntry.enabled).toBe(false);
    });

    it("reports ok when nothing has ever run and every job is disabled", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings({
            libraryPollingEnabled: false, watchlistEnabled: false,
            freePromosEnabled: false, achievementMonitoringEnabled: false,
        }));
        mockJobRuns({});

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("ok");
    });

    it("excludes a disabled job's old failure from the failing status", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings({ watchlistEnabled: false }));
        mockJobRuns({
            library: recentOkRun(),
            watchlist: { startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), ok: false, error: "boom" },
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("ok");
    });

    it("does not report ok for an interrupted library run, even with a fresh startedAt", async () => {
        // Recent startedAt, finishedAt: null, ok: null — opened by openRun, never closed by
        // closeRun (the process died mid-run). A crash loop that restarts faster than the
        // staleness threshold refreshes startedAt on every restart while ok === false is never
        // recorded, so elapsed-time-only staleness would report "ok" through an unbroken failure.
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: { startedAt: new Date(), ok: null },
            watchlist: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        const body = await (await GET()).json();

        expect(body.status).not.toBe("ok");
        expect(body.jobs.find((j: { job: string }) => j.job === "library").finishedAt).toBeNull();
        expect(body.jobs.find((j: { job: string }) => j.job === "library").ok).toBeNull();
    });

    it("goes stale when a non-library job (watchlist) exceeds its own threshold, even though every other job is healthy", async () => {
        // Previously staleness was computed only for library, so a dead watchlist/free-promos/
        // achievements job left the headline status at "ok" forever. watchlist's threshold is
        // 3 * 12h = 36h; 37h silent must now flip the headline status.
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: recentOkRun(),
            watchlist: { startedAt: new Date(Date.now() - 37 * 60 * 60 * 1000), ok: true },
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("stale");
    });

    it("does not go stale for free-promos silent only within its own daily off-window", async () => {
        // free-promos threshold (interval 1h * 3 + 9h off-window) = 12h; 5 hours silent (e.g.
        // last ran 23:00, checked again at 04:00) is well inside it — the every-night false alarm.
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: recentOkRun(),
            watchlist: recentOkRun(),
            "free-promos": { startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000), ok: true },
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        expect((await (await GET()).json()).status).toBe("ok");
    });

    it("does not let a disabled job's long silence affect the headline status", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings({ watchlistEnabled: false }));
        mockJobRuns({
            library: recentOkRun(),
            watchlist: { startedAt: new Date(Date.now() - 200 * 60 * 60 * 1000), ok: true }, // ~8 days silent, disabled
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        const body = await (await GET()).json();

        expect(body.status).toBe("ok");
        // The per-job entry itself must carry why watchlist is quiet, so an external consumer
        // does not have to guess "disabled" from "broken" — a disabled job renders as off, never
        // as stale, on every surface.
        const watchlistEntry = body.jobs.find((j: { job: string }) => j.job === "watchlist");
        expect(watchlistEntry.enabled).toBe(false);
    });

    it("marks every other job's entry enabled, so the absence of the flag never has to be inferred", async () => {
        prismaMock.settings.findUnique.mockResolvedValueOnce(makeSettings());
        mockJobRuns({
            library: recentOkRun(),
            watchlist: recentOkRun(),
            "free-promos": recentOkRun(),
            achievements: recentOkRun(),
        });

        const { GET } = await import("../app/api/health/route");
        const body = await (await GET()).json();

        for (const job of body.jobs) {
            expect(job.enabled).toBe(true);
        }
    });
});
