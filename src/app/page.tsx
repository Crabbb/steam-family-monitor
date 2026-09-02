// FILE: src/app/page.tsx
// VERSION: 1.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Main overview dashboard component
//   SCOPE: Display monitored users count, total games recorded, and the latest run per scheduled job
//   DEPENDS: M-DB, M-JOBRUN
//   LINKS: M-UI
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DashboardPage — Server component: stat cards plus the "Последние прогоны" job-run panel
//   JobRunPanel — Renders one row per known job from describeJobRun's output
//   describeJobRun — Derive a job's display status (off/never/ok/stale/failing) and time-ago label; exported for direct unit testing
// END_MODULE_MAP

import { prisma } from "../lib/db";
import { Users, Gamepad2, Send, Eye, Gift } from "lucide-react";
import { getLastRuns, getStaleThresholdMs, isJobEnabled, JOB_NAMES, JOB_TITLES, JobName, JobRunSummary } from "../lib/jobRun";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";

export const dynamic = "force-dynamic";

export type JobStatus = "off" | "never" | "ok" | "stale" | "failing";

export interface JobRow {
    key: JobName;
    title: string;
    status: JobStatus;
    timeLabel: string;
    error: string | null;
}

const STATUS_COLOR: Record<JobStatus, string> = {
    ok: "text-emerald-400",
    stale: "text-amber-400",
    failing: "text-red-400",
    never: "text-zinc-400",
    off: "text-zinc-400",
};

const STATUS_LABEL: Record<JobStatus, string> = {
    ok: "ок",
    stale: "нет свежих данных",
    failing: "ошибка",
    never: "нет данных",
    off: "выключено",
};

// START_CONTRACT: describeJobRun
//   PURPOSE: Turn one job's latest run (or its absence) into a display status and a Russian
//     time-ago label. A disabled job always reads "off", regardless of run history — a job the
//     owner deliberately turned off must never render as "stale" (an alarm about an unexpected
//     silence) when the silence was requested. "off" and "never" (enabled, no row yet) are kept
//     as distinct states because their causes differ: one is a choice, the other is pending data.
//   INPUTS: { key: JobName, run: JobRunSummary | undefined — undefined means the job has never run, staleAfterMs: number — that job's own threshold from getStaleThresholdMs, never a value borrowed from another job, enabled: boolean — whether the job is currently switched on }
//   OUTPUTS: { JobRow }
//   SIDE_EFFECTS: none
//   LINKS: M-UI, M-JOBRUN
// END_CONTRACT: describeJobRun
export function describeJobRun(key: JobName, run: JobRunSummary | undefined, staleAfterMs: number, enabled: boolean): JobRow {
    const title = JOB_TITLES[key];
    // Last-run time is still worth showing for a disabled job (useful history, not an alarm), so
    // this is computed once regardless of the enabled/never-run branch below.
    const timeLabel = run
        ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true, locale: ru })
        : "ещё ни разу не запускалась";

    if (!enabled) {
        return { key, title, status: "off", timeLabel, error: null };
    }

    if (!run) {
        return { key, title, status: "never", timeLabel, error: null };
    }

    if (run.ok === false) {
        return { key, title, status: "failing", timeLabel, error: run.error };
    }

    // ok === null means the run was opened but never closed (the process died mid-run) — that is
    // neither a confirmed success nor a confirmed failure, so it reads the same as "stale": data
    // that can no longer be trusted as current, not a hard fault.
    const isStale = run.ok === null || Date.now() - new Date(run.startedAt).getTime() > staleAfterMs;

    return { key, title, status: isStale ? "stale" : "ok", timeLabel, error: null };
}

export default async function DashboardPage() {
  const usersCount = await prisma.user.count();
  const gamesCount = await prisma.game.count();
  const msgsCount = await prisma.messageHistory.count();
  const watchCount = await prisma.watchedGame.count();
  const freePromosCount = await prisma.freePromotionNotification.count();

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const runs = await getLastRuns();
  const runByJob = new Map(runs.map(run => [run.job, run]));

  // Every job gets its own threshold — free-promos and achievements only run inside a daily
  // window, so their threshold includes that window's length (see getStaleThresholdMs), not just
  // a multiple of their polling interval.
  const jobRows: JobRow[] = JOB_NAMES.map(key =>
      describeJobRun(key, runByJob.get(key), getStaleThresholdMs(key, settings), isJobEnabled(key, settings))
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white tracking-tight">Dashboard</h2>
        <p className="text-zinc-400 mt-2">Overview of Steam monitoring activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
        <StatCard
          title="Monitored Users"
          value={usersCount.toString()}
          icon={<Users className="text-blue-400" size={24} />}
        />
        <StatCard
          title="Known Games Tracking"
          value={gamesCount.toString()}
          icon={<Gamepad2 className="text-emerald-400" size={24} />}
        />
        <StatCard
          title="Notifications Sent"
          value={msgsCount.toString()}
          icon={<Send className="text-indigo-400" size={24} />}
        />
        <StatCard
          title="Watched Games"
          value={watchCount.toString()}
          icon={<Eye className="text-amber-400" size={24} />}
        />
        <StatCard
          title="Free Promos Sent"
          value={freePromosCount.toString()}
          icon={<Gift className="text-pink-400" size={24} />}
        />
      </div>

      <JobRunPanel rows={jobRows} />
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-400">{title}</h3>
        {icon}
      </div>
      <p className="text-3xl font-bold text-white mt-4">{value}</p>
    </div>
  );
}

function JobRunPanel({ rows }: { rows: JobRow[] }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-white mb-4">Последние прогоны</h3>
      <div className="divide-y divide-zinc-800">
        {rows.map(row => (
          <div key={row.key} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
            <div>
              <p className="text-white font-medium">{row.title}</p>
              <p className="text-sm text-zinc-400">{row.timeLabel}</p>
              {row.error && (
                <p className="text-xs text-zinc-500 mt-1 max-w-md truncate" title={row.error}>
                  {row.error}
                </p>
              )}
            </div>
            <p className={`font-semibold ${STATUS_COLOR[row.status]}`}>{STATUS_LABEL[row.status]}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Added the "Последние прогоны" job-run panel below the stat grid, sourced from getLastRuns; library staleness reuses the same three-interval rule as /api/health]
//   LAST_CHANGE_2: [v1.2.0 - JOB_TITLES and STALE_INTERVAL_MULTIPLIER now imported from lib/jobRun.ts instead of duplicated locally; describeJobRun exported for direct unit testing of the ok === null branch]
//   LAST_CHANGE_3: [v1.3.0 - describeJobRun now takes every job's own threshold via getStaleThresholdMs, not library's threshold or null; watchlist/free-promos/achievements can now show "stale" too. Removed the dead `?? key` title fallback (JOB_TITLES is a total Record<JobName, string>)]
//   LAST_CHANGE_4: [v1.4.0 - Added a distinct "off" status: a disabled job now always reads as switched off (with its last-run time still shown as history) instead of "stale", so a deliberate configuration can no longer be mistaken for an unexpected silence]
// END_CHANGE_SUMMARY
