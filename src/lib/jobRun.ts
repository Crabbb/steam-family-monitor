// FILE: src/lib/jobRun.ts
// VERSION: 1.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Record every scheduled job run so silence can be told apart from failure
//   SCOPE: runTracked wrapper for cron callbacks and getLastRuns reader for UI, API and bot
//   DEPENDS: M-DB
//   LINKS: M-JOBRUN
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   runTracked — Wrap one cron callback: open a run row, run the job, close it with status and count
//   openRun — Insert a JobRun row without ever throwing, so a bookkeeping failure cannot stop the job from running
//   closeRun — Persist a run's final status without ever throwing, so a bookkeeping failure cannot escape runTracked
//   getLastRuns — Latest row per known job, looked up individually so one job's write volume cannot hide another
//   JOB_NAMES — Every known job name, derived from a JobName-complete object so a forgotten member fails the build
//   JOB_TITLES — Russian display name per job, typed Record<JobName, string> so a forgotten title fails the build
//   STALE_INTERVAL_MULTIPLIER — Shared "how many missed intervals before stale" threshold for every surface
//   getStaleThresholdMs — Per-job "how long is too long" threshold, accounting for jobs that only run inside a daily window
//   isJobEnabled — Whether a job is currently supposed to run at all, per its own settings toggle
// END_MODULE_MAP

import { prisma } from "./db";

export type JobName = "library" | "watchlist" | "free-promos" | "achievements";

// A forgotten job is invisible everywhere downstream, so make omission a compile error
// rather than a silent gap: adding a name to JobName without adding it here fails the build.
const JOB_NAME_SET = {
    library: true,
    watchlist: true,
    "free-promos": true,
    achievements: true,
} satisfies Record<JobName, true>;

export const JOB_NAMES = Object.keys(JOB_NAME_SET) as readonly JobName[];

// Single source of truth for the Russian display name of every job, shared by the dashboard,
// /api/health-adjacent surfaces and the bot's /status command so the three can never drift apart
// (rename a title in one place and every consumer sees it). Typed as Record<JobName, string>,
// not Record<string, string>, so adding a JobName without adding its title fails the build the
// same way JOB_NAMES does.
export const JOB_TITLES: Record<JobName, string> = {
    library: "Библиотека",
    watchlist: "Watchlist",
    "free-promos": "Бесплатные раздачи",
    achievements: "Достижения",
};

// Shared "how many missed intervals before a job counts as stale" threshold. One missed tick can
// happen for an ordinary transient reason (a slow prior run, a brief restart) and should not read
// as a fault; three consecutive misses is no longer a coincidence. Kept here so /api/health and
// the dashboard can never silently disagree on the multiplier.
export const STALE_INTERVAL_MULTIPLIER = 3;

export type SettingsRow = Awaited<ReturnType<typeof prisma.settings.findUnique>>;

// START_CONTRACT: getStaleThresholdMs
//   PURPOSE: Compute how long a job may go silent before it counts as stale, using that job's own
//     cadence — never a shared number — so every surface (dashboard, /api/health, /status) judges
//     staleness the same way for every job, not only for library
//   INPUTS: { jobName: JobName, settings: SettingsRow }
//   OUTPUTS: { number — threshold in milliseconds }
//   SIDE_EFFECTS: none
//   LINKS: M-JOBRUN
//
//   On the off-window term (free-promos, achievements): these two jobs only run inside a daily
//   hour window (e.g. 09:00–23:00), so at any moment before the window reopens, their last run is
//   legitimately as old as the window is long — a promotions job checked hourly that last ran at
//   23:00 has, by design, not run again by 04:00. Multiplying only the polling interval by
//   STALE_INTERVAL_MULTIPLIER ignores that gap and would report "stale" every single night,
//   which trains the operator to stop trusting (or stop reading) the panel — the same failure
//   mode as a false "ok". The threshold therefore adds the off-window's own length in hours,
//   computed purely from the configured start/end hour (`24 - (endHour - startHour + 1)`): no
//   date arithmetic, no timezone conversion. The window's *length* does not depend on which
//   timezone it is expressed in, only its *position* in the day does, and position is irrelevant
//   to "how long can this job legitimately stay silent." Deleting this term looks like a harmless
//   simplification but reintroduces the nightly false alarm.
// END_CONTRACT: getStaleThresholdMs
export function getStaleThresholdMs(jobName: JobName, settings: SettingsRow): number {
    const MINUTE_MS = 60 * 1000;
    const HOUR_MS = 60 * MINUTE_MS;

    switch (jobName) {
        case "library": {
            const intervalMinutes = settings?.checkInterval || 15;
            return intervalMinutes * STALE_INTERVAL_MULTIPLIER * MINUTE_MS;
        }
        case "watchlist": {
            // Runs around the clock — no daily window, so no off-window term.
            const intervalHours = settings?.watchlistIntervalHours || 12;
            return intervalHours * STALE_INTERVAL_MULTIPLIER * HOUR_MS;
        }
        case "free-promos": {
            const intervalHours = settings?.freePromosIntervalHours ?? 1;
            const startHour = settings?.freePromosStartHour ?? 9;
            const endHour = settings?.freePromosEndHour ?? 23;
            const offWindowHours = 24 - (endHour - startHour + 1);
            return (intervalHours * STALE_INTERVAL_MULTIPLIER + offWindowHours) * HOUR_MS;
        }
        case "achievements": {
            const intervalHours = settings?.achievementIntervalHours ?? 6;
            const startHour = settings?.achievementStartHour ?? 9;
            const endHour = settings?.achievementEndHour ?? 23;
            const offWindowHours = 24 - (endHour - startHour + 1);
            return (intervalHours * STALE_INTERVAL_MULTIPLIER + offWindowHours) * HOUR_MS;
        }
    }
}

// START_CONTRACT: isJobEnabled
//   PURPOSE: Resolve whether a job is currently enabled, so a disabled job's old run (failing,
//     unresolved, or merely stale) never keeps alarming after an operator has turned it off — it
//     is not supposed to run, so it cannot be judged for not running
//   INPUTS: { jobName: string, settings: SettingsRow }
//   OUTPUTS: { boolean — true when enabled or the setting is unknown/unset (fail open, never hide a real problem) }
//   SIDE_EFFECTS: none
//   LINKS: M-JOBRUN
// END_CONTRACT: isJobEnabled
export function isJobEnabled(jobName: string, settings: SettingsRow): boolean {
    switch (jobName) {
        case "library": return settings?.libraryPollingEnabled ?? true;
        case "watchlist": return settings?.watchlistEnabled ?? true;
        case "free-promos": return settings?.freePromosEnabled ?? true;
        case "achievements": return settings?.achievementMonitoringEnabled ?? true;
        default: return true;
    }
}

export interface RunReport {
    // No job currently reads or mutates this — every stored row's `processed` is always 0 until
    // a job actually reports real counts (tracked as a follow-up). Do not surface this value to
    // users as if it meant anything yet.
    processed: number;
}

export interface JobRunSummary {
    job: string;
    startedAt: Date;
    finishedAt: Date | null;
    ok: boolean | null;
    processed: number;
    error: string | null;
}

const ERROR_MAX_CHARS = 1000;

interface RunOutcome {
    finishedAt: Date;
    ok: boolean;
    processed: number;
    error: string | null;
}

// START_CONTRACT: openRun
//   PURPOSE: Insert a JobRun row without ever throwing, so a bookkeeping failure cannot stop the job from running
//   INPUTS: { job: JobName }
//   OUTPUTS: { Promise<number | null> — the new row id, or null when the insert itself failed }
//   SIDE_EFFECTS: Inserts a JobRun row; a failure is logged and swallowed, never propagated
//   LINKS: M-JOBRUN
// END_CONTRACT: openRun
async function openRun(job: JobName): Promise<number | null> {
    try {
        const run = await prisma.jobRun.create({ data: { job } });
        return run.id;
    } catch (error) {
        console.error(`[M-JOBRUN][${job}] failed to open a run record (job still executes):`, error);
        return null;
    }
}

// START_CONTRACT: closeRun
//   PURPOSE: Persist a run's final status without ever throwing, so a bookkeeping failure cannot escape runTracked
//   INPUTS: { job: JobName, runId: number | null, outcome: RunOutcome }
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: Updates the JobRun row opened by openRun, when one exists; a missing run id or an update failure is logged and swallowed, never propagated
//   LINKS: M-JOBRUN
// END_CONTRACT: closeRun
async function closeRun(job: JobName, runId: number | null, outcome: RunOutcome): Promise<void> {
    if (runId === null) {
        console.error(`[M-JOBRUN][${job}] no run id (open failed earlier) — outcome not recorded`);
        return;
    }

    try {
        await prisma.jobRun.update({ where: { id: runId }, data: outcome });
    } catch (error) {
        console.error(`[M-JOBRUN][${job}] failed to record run outcome:`, error);
    }
}

// START_CONTRACT: runTracked
//   PURPOSE: Run one job and record its outcome, with two guarantees held independently of each
//     other: the job's own exception is always captured here and never propagates to the caller,
//     and a failure to open or close the JobRun bookkeeping row is also always logged and
//     swallowed rather than propagated — one failing to record does not stop the job from running,
//     and the job's own crash never depends on the bookkeeping having worked
//   INPUTS: { job: JobName, fn: (report: RunReport) => Promise<T> }
//   OUTPUTS: { Promise<T | null> — null when the job threw }
//   SIDE_EFFECTS: Inserts and updates a JobRun row (see openRun/closeRun for their own failure handling)
//   LINKS: M-JOBRUN, M-CRON
// END_CONTRACT: runTracked
export async function runTracked<T>(job: JobName, fn: (report: RunReport) => Promise<T>): Promise<T | null> {
    const report: RunReport = { processed: 0 };
    const runId = await openRun(job);

    try {
        const result = await fn(report);
        await closeRun(job, runId, { finishedAt: new Date(), ok: true, processed: report.processed, error: null });
        console.log(`[M-JOBRUN][${job}] ok, processed ${report.processed}`);
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await closeRun(job, runId, {
            finishedAt: new Date(),
            ok: false,
            processed: report.processed,
            error: message.slice(0, ERROR_MAX_CHARS),
        });
        console.error(`[M-JOBRUN][${job}] failed:`, error);
        return null;
    }
}

// START_CONTRACT: getLastRuns
//   PURPOSE: Latest run per job for the dashboard, health endpoint and /status — looks up each
//     known job by name instead of slicing a shared "last N rows" window and de-duplicating,
//     because a high-frequency job (e.g. library polling every few minutes) can fill such a
//     window entirely and push a low-frequency job's most recent run out of it; the missing job
//     then reads as healthy silence instead of a stalled cron. A per-job lookup, backed by the
//     [job, startedAt] index, cannot be starved by another job's write volume.
//   INPUTS: none
//   OUTPUTS: { Promise<JobRunSummary[]> — one entry per job that has ever run; a job with no row yet is simply absent }
//   SIDE_EFFECTS: none
//   LINKS: M-JOBRUN
// END_CONTRACT: getLastRuns
export async function getLastRuns(): Promise<JobRunSummary[]> {
    // Query the latest row per job, never a window of recent rows. The jobs run at wildly
    // different cadences (library every 15 min by default and configurable down to minutes,
    // watchlist every 12 hours), so any "last N rows" slice can push a rare job out of the
    // result entirely — and a job missing from this list is indistinguishable from a job that
    // silently died, which is the exact blindness this plan removes.
    const runs: JobRunSummary[] = [];

    for (const job of JOB_NAMES) {
        const row = await prisma.jobRun.findFirst({ where: { job }, orderBy: { startedAt: "desc" } });
        if (row) runs.push(row);
    }

    return runs;
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Job runs are recorded so a dead monitor stops looking like a quiet one]
//   LAST_CHANGE_2: [v1.1.0 - getLastRuns queries each job by name instead of slicing the last 100 rows, so a low-frequency job can no longer be pushed out of the window by a high-frequency one]
//   LAST_CHANGE_3: [v1.2.0 - JOB_NAMES is derived from a satisfies-checked Record<JobName, true> so a JobName added without updating this file fails to compile]
//   LAST_CHANGE_4: [v1.3.0 - runTracked's own bookkeeping (open and close) is now self-guarded via openRun/closeRun instead of relying on the process-wide unhandledRejection guard in worker.ts; RunReport.processed documented as always 0 until a job populates it (follow-up, out of this plan's scope)]
//   LAST_CHANGE_5: [v1.4.0 - JOB_TITLES and STALE_INTERVAL_MULTIPLIER moved here from page.tsx/telegramBot.ts, which had each independently duplicated them; JOB_TITLES is Record<JobName, string> so a new job cannot be added without a title]
//   LAST_CHANGE_6: [v1.5.0 - Added getStaleThresholdMs: per-job staleness threshold (was library-only elsewhere), adding an off-window term for free-promos/achievements so their daily inactive hours never read as stale; moved isJobEnabled here from the health route, next to the other settings-derived per-job helpers, still used only by /api/health's headline computation]
// END_CHANGE_SUMMARY
