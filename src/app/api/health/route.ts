// FILE: src/app/api/health/route.ts
// VERSION: 1.4.0
// START_MODULE_CONTRACT
//   PURPOSE: GET /api/health — machine-readable liveness of the scheduled jobs
//   SCOPE: Derives an overall status from the latest run per job, judged against each job's own
//     staleness threshold; exposes exactly one entry per known job (never fewer), each job's
//     enabled state, and the derived headline status only, never settings values such as API
//     keys or tokens
//   DEPENDS: M-DB, M-JOBRUN
//   LINKS: M-API
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GET — Handle GET /api/health
//   isJobStale — One job's stale verdict: never run, unresolved, or older than its own threshold
// END_MODULE_MAP

import { NextResponse } from "next/server";
import { prisma } from "../../../lib/db";
import { getLastRuns, getStaleThresholdMs, isJobEnabled, JOB_NAMES, JobName } from "../../../lib/jobRun";

export const dynamic = "force-dynamic";

// One row of the detail list this endpoint reports. There is always exactly one of these per
// entry in JOB_NAMES, in JOB_NAMES order, whether or not that job has ever produced a JobRun row
// — see GET's contract for why a job's absence from `jobs` would be a bug, not a valid state.
interface HealthJobEntry {
    job: JobName;
    startedAt: Date | null;
    finishedAt: Date | null;
    ok: boolean | null;
    processed: number | null;
    error: string | null;
    enabled: boolean;
}

// START_CONTRACT: isJobStale
//   PURPOSE: Decide whether one job counts as stale: it has never run (startedAt === null), its
//     last run was opened but never closed (ok === null — the process died mid-run, not a
//     confirmed success), or its last startedAt is older than that job's own threshold
//     (getStaleThresholdMs — never a value borrowed from another job). Never called for a
//     disabled job — see the stale computation in GET, which checks `enabled` first — because a
//     disabled job is never stale by definition.
//   INPUTS: { jobName: JobName, run: { ok: boolean | null, startedAt: Date | null } | undefined — undefined and a null startedAt both mean "no evidence this job has ever run", settings: Parameters<typeof getStaleThresholdMs>[1] }
//   OUTPUTS: { boolean }
//   SIDE_EFFECTS: none
//   LINKS: M-JOBRUN
// END_CONTRACT: isJobStale
function isJobStale(jobName: JobName, run: { ok: boolean | null; startedAt: Date | null } | undefined, settings: Parameters<typeof getStaleThresholdMs>[1]): boolean {
    if (!run || run.ok === null || run.startedAt === null) return true;
    const thresholdMs = getStaleThresholdMs(jobName, settings);
    return Date.now() - new Date(run.startedAt).getTime() > thresholdMs;
}

// START_CONTRACT: GET
//   PURPOSE: Report the overall job health plus one detail entry per known job
//   INPUTS: none
//   OUTPUTS: { Promise<NextResponse> — { status: "ok" | "stale" | "failing", jobs: HealthJobEntry[], checkedAt: string }.
//     `jobs` always has exactly JOB_NAMES.length entries, one per known job, in JOB_NAMES order —
//     NOT one entry per row that happens to exist. A job with no JobRun row yet still gets an
//     entry, with startedAt/finishedAt/ok/processed/error explicitly null and `enabled` set as
//     usual, so a consumer can always tell "never ran" from "ran and succeeded" from "off"
//     without inferring anything from a missing array element. ABSENCE FROM THIS ARRAY IS NOT A
//     MEANINGFUL STATE ANYMORE: do not reintroduce mapping getLastRuns()'s sparse result directly
//     into `jobs` as a shortcut — that once left a fresh deployment reporting headline "stale"
//     with no row anywhere in the response naming which job caused it. }
//   SIDE_EFFECTS: none (read-only)
//   LINKS: M-DB, M-JOBRUN
// END_CONTRACT: GET
export async function GET() {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    const runsByName = new Map((await getLastRuns()).map(run => [run.job, run]));

    // START_BLOCK_JOBS_LIST
    // Walk the canonical job list, never getLastRuns()'s sparse result — a job with no row yet
    // still gets an entry here (run fields explicitly null), so the detail list can always name
    // every job the headline status is judging, including the one that has never run.
    const jobs: HealthJobEntry[] = JOB_NAMES.map(jobName => {
        const run = runsByName.get(jobName);
        const enabled = isJobEnabled(jobName, settings);

        if (!run) {
            return { job: jobName, startedAt: null, finishedAt: null, ok: null, processed: null, error: null, enabled };
        }
        return { job: jobName, startedAt: run.startedAt, finishedAt: run.finishedAt, ok: run.ok, processed: run.processed, error: run.error, enabled };
    });
    // END_BLOCK_JOBS_LIST

    // START_BLOCK_STATUS_RULE
    // failing: any job that is currently enabled, has actually run, and reported ok === false. A
    // job with no row yet (never run) has ok === null here and can never satisfy this check —
    // that would be indistinguishable from a dead job, which is exactly the ambiguity this
    // endpoint exists to remove. A disabled job's old failing row is excluded too, so turning a
    // broken job off silences the alarm instead of leaving it stuck on forever.
    const failing = jobs.some(job => job.ok === false && job.enabled);

    // stale: any enabled job that has never run, is unresolved (ok === null — opened but never
    // closed, e.g. a crash loop that restarts faster than the staleness threshold would otherwise
    // refresh startedAt on every restart while ok === false is never recorded), or is older than
    // ITS OWN threshold from getStaleThresholdMs — never one shared number. A disabled job is
    // never stale — it is not supposed to run, so it cannot be judged for not running.
    const stale = jobs.some(job => job.enabled && isJobStale(job.job, job, settings));
    // END_BLOCK_STATUS_RULE

    return NextResponse.json({
        status: failing ? "failing" : stale ? "stale" : "ok",
        checkedAt: new Date().toISOString(),
        jobs,
    });
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - GET /api/health reports failing/stale/ok from the latest JobRun per job, gated by each job's own enabled setting, without ever exposing settings values]
//   LAST_CHANGE_2: [v1.1.0 - stale now also fires when the library run is unresolved (ok === null, opened but never closed), not only when it is old; fixes a crash-loop blind spot where restarts kept refreshing startedAt while ok === false was never recorded. STALE_INTERVAL_MULTIPLIER now imported from lib/jobRun.ts instead of duplicated here]
//   LAST_CHANGE_3: [v1.2.0 - stale is now computed per job via getStaleThresholdMs (watchlist/free-promos/achievements previously had no staleness check at all, so a dead one of those left the headline status at "ok" forever); isJobEnabled moved to lib/jobRun.ts]
//   LAST_CHANGE_4: [v1.3.0 - Each job entry in `jobs` now carries `enabled`, so an external consumer can tell a disabled job's silence apart from a broken one without settings access; `failing` now reads the precomputed `job.enabled` instead of calling isJobEnabled a second time]
//   LAST_CHANGE_5: [v1.4.0 - `jobs` is now built by walking JOB_NAMES instead of mapping getLastRuns()'s sparse result, so a job with no row yet still gets an entry (run fields explicitly null) instead of vanishing from the array — a fresh deployment could previously report headline "stale" with no row anywhere naming the job that caused it. failing/stale now read directly off this dense array]
// END_CHANGE_SUMMARY
