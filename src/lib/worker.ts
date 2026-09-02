// FILE: src/lib/worker.ts
// VERSION: 2.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Registers and runs background jobs: library polling, watchlist price check, free promotions, achievement monitoring, Telegram bot
//   SCOPE: Wrapper for node-cron + Telegram bot long-polling lifecycle
//   DEPENDS: M-CORE, M-DB, M-WATCHLIST, M-FREEPROMOS, M-ACHIEVEMENTS, M-TGBOT
//   LINKS: M-CRON
// END_MODULE_CONTRACT

import * as cron from "node-cron";
import { pollAllUsers } from "./core";
import { prisma } from "./db";
import { checkWatchlistPrices } from "./watchlist";
import { checkFreePromotions } from "./freePromotions";
import { checkPerfectAchievements } from "./achievements";

interface WorkerState {
    currentTask: cron.ScheduledTask | null;
    currentSignature: string;
    watchlistTask: cron.ScheduledTask | null;
    watchlistSignature: string;
    freePromosTask: cron.ScheduledTask | null;
    freePromosSignature: string;
    achievementsTask: cron.ScheduledTask | null;
    achievementsSignature: string;
}

const globalForWorker = globalThis as typeof globalThis & {
    steamMonitorWorkerState?: WorkerState;
    steamMonitorWorkerCrashGuardRegistered?: boolean;
};

const workerState = globalForWorker.steamMonitorWorkerState ??= {
    currentTask: null,
    currentSignature: "",
    watchlistTask: null,
    watchlistSignature: "",
    freePromosTask: null,
    freePromosSignature: "",
    achievementsTask: null,
    achievementsSignature: "",
};

// START_BLOCK_CRASH_GUARD
// Prevent unhandled rejections from killing the process
if (!globalForWorker.steamMonitorWorkerCrashGuardRegistered) {
    process.on("unhandledRejection", (reason) => {
        console.error("[M-CRON] Unhandled rejection caught (worker kept alive):", reason);
    });
    globalForWorker.steamMonitorWorkerCrashGuardRegistered = true;
}
// END_BLOCK_CRASH_GUARD

export function buildWatchlistCron(intervalHours: number): string {
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) {
        throw new Error("watchlist interval hours must be between 1 and 24");
    }
    return `0 */${intervalHours} * * *`;
}

export function buildFreePromotionsCron(startHour: number, endHour: number, intervalHours: number): string {
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
        throw new Error("hours must be between 0 and 23");
    }
    if (startHour > endHour) {
        throw new Error("start hour must be less than or equal to end hour");
    }
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) {
        throw new Error("interval hours must be between 1 and 24");
    }
    return `0 ${startHour}-${endHour}/${intervalHours} * * *`;
}

export function buildPerfectAchievementsCron(startHour: number, endHour: number, intervalHours: number): string {
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
        throw new Error("hours must be between 0 and 23");
    }
    if (startHour > endHour) {
        throw new Error("start hour must be less than or equal to end hour");
    }
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) {
        throw new Error("interval hours must be between 1 and 24");
    }
    return `0 ${startHour}-${endHour}/${intervalHours} * * *`;
}

// START_CONTRACT: startWorker
//   PURPOSE: Initialize and reconfigure background polling jobs
//   INPUTS: {}
//   OUTPUTS: { void }
//   SIDE_EFFECTS: Registers cron jobs and logs start/stop events
//   LINKS: M-CRON
// END_CONTRACT: startWorker
export async function startWorker() {
    try {
        const settings = await prisma.settings.findUnique({ where: { id: 1 } });
        const interval = settings?.checkInterval || 15;
        const libraryPollingEnabled = settings?.libraryPollingEnabled ?? true;

        const librarySignature = libraryPollingEnabled ? `library:${interval}` : "library:disabled";
        if (workerState.currentSignature !== librarySignature) {
            if (workerState.currentTask) {
                console.log("[M-CRON] Stopping old library worker task");
                workerState.currentTask.stop();
                workerState.currentTask = null;
            }

            if (libraryPollingEnabled) {
                const cronStr = `*/${interval} * * * *`;
                console.log(`[M-CRON] Starting library worker with schedule: ${cronStr}`);

                workerState.currentTask = cron.schedule(cronStr, async () => {
                    // START_BLOCK_LIBRARY_CRON
                    console.log(`[M-CRON] Library cron triggered at ${new Date().toISOString()}`);
                    try {
                        await pollAllUsers();
                    } catch (err) {
                        console.error("[M-CRON] pollAllUsers crashed (will retry next cycle):", err);
                    }
                    // END_BLOCK_LIBRARY_CRON
                });
            } else {
                console.log("[M-CRON] Library polling disabled");
            }

            workerState.currentSignature = librarySignature;
        }

        const watchlistEnabled = settings?.watchlistEnabled ?? true;
        const watchlistIntervalHours = settings?.watchlistIntervalHours || 12;
        const nextWatchlistSignature = watchlistEnabled ? `watchlist:${watchlistIntervalHours}` : "watchlist:disabled";
        if (workerState.watchlistSignature !== nextWatchlistSignature) {
            if (workerState.watchlistTask) {
                console.log("[M-CRON] Stopping old watchlist task");
                workerState.watchlistTask.stop();
                workerState.watchlistTask = null;
            }

            if (watchlistEnabled) {
                const cronStr = buildWatchlistCron(watchlistIntervalHours);
                workerState.watchlistTask = cron.schedule(cronStr, async () => {
                    // START_BLOCK_WATCHLIST_CRON
                    console.log(`[M-CRON] Watchlist price check triggered at ${new Date().toISOString()}`);
                    try {
                        await checkWatchlistPrices();
                    } catch (err) {
                        console.error("[M-CRON] Watchlist check crashed (will retry next cycle):", err);
                    }
                    // END_BLOCK_WATCHLIST_CRON
                });
                console.log(`[M-CRON] Watchlist cron registered: ${cronStr}`);
            } else {
                console.log("[M-CRON] Watchlist cron disabled");
            }

            workerState.watchlistSignature = nextWatchlistSignature;
        }

        const freePromosEnabled = settings?.freePromosEnabled ?? true;
        const freePromosStartHour = settings?.freePromosStartHour ?? 9;
        const freePromosEndHour = settings?.freePromosEndHour ?? 23;
        const freePromosIntervalHours = settings?.freePromosIntervalHours ?? 1;
        const freePromosTimezone = settings?.freePromosTimezone || "Europe/Samara";
        const nextFreePromosSignature = freePromosEnabled
            ? `free-promos:${freePromosStartHour}:${freePromosEndHour}:${freePromosIntervalHours}:${freePromosTimezone}`
            : "free-promos:disabled";

        if (workerState.freePromosSignature !== nextFreePromosSignature) {
            if (workerState.freePromosTask) {
                console.log("[M-CRON] Stopping old free promotions task");
                workerState.freePromosTask.stop();
                workerState.freePromosTask = null;
            }

            if (freePromosEnabled) {
                const cronStr = buildFreePromotionsCron(freePromosStartHour, freePromosEndHour, freePromosIntervalHours);
                workerState.freePromosTask = cron.schedule(cronStr, async () => {
                    // START_BLOCK_FREE_PROMOS_CRON
                    console.log(`[M-CRON] Free promotions check triggered at ${new Date().toISOString()}`);
                    try {
                        await checkFreePromotions();
                    } catch (err) {
                        console.error("[M-CRON] Free promotions check crashed (will retry next cycle):", err);
                    }
                    // END_BLOCK_FREE_PROMOS_CRON
                }, { timezone: freePromosTimezone });
                console.log(`[M-CRON] Free promotions cron registered: ${cronStr} (${freePromosTimezone})`);
            } else {
                console.log("[M-CRON] Free promotions cron disabled");
            }

            workerState.freePromosSignature = nextFreePromosSignature;
        }

        const achievementMonitoringEnabled = settings?.achievementMonitoringEnabled ?? true;
        const achievementStartHour = settings?.achievementStartHour ?? 9;
        const achievementEndHour = settings?.achievementEndHour ?? 23;
        const achievementIntervalHours = settings?.achievementIntervalHours ?? 6;
        const achievementTimezone = settings?.achievementTimezone || "Europe/Samara";
        const nextAchievementsSignature = achievementMonitoringEnabled
            ? `achievements:${achievementStartHour}:${achievementEndHour}:${achievementIntervalHours}:${achievementTimezone}`
            : "achievements:disabled";

        if (workerState.achievementsSignature !== nextAchievementsSignature) {
            if (workerState.achievementsTask) {
                console.log("[M-CRON] Stopping old achievement monitoring task");
                workerState.achievementsTask.stop();
                workerState.achievementsTask = null;
            }

            if (achievementMonitoringEnabled) {
                const cronStr = buildPerfectAchievementsCron(achievementStartHour, achievementEndHour, achievementIntervalHours);
                workerState.achievementsTask = cron.schedule(cronStr, async () => {
                    // START_BLOCK_ACHIEVEMENTS_CRON
                    console.log(`[M-CRON] Perfect achievements check triggered at ${new Date().toISOString()}`);
                    try {
                        await checkPerfectAchievements();
                    } catch (err) {
                        console.error("[M-CRON] Perfect achievements check crashed (will retry next cycle):", err);
                    }
                    // END_BLOCK_ACHIEVEMENTS_CRON
                }, { timezone: achievementTimezone });
                console.log(`[M-CRON] Perfect achievements cron registered: ${cronStr} (${achievementTimezone})`);
            } else {
                console.log("[M-CRON] Perfect achievements cron disabled");
            }

            workerState.achievementsSignature = nextAchievementsSignature;
        }

        // Start Telegram bot long-polling (fire-and-forget)
        try {
            const { startTelegramBot } = await import("./telegramBot");
            startTelegramBot();
        } catch (err) {
            console.error("[M-CRON] Failed to start Telegram bot:", err);
        }
    } catch (err) {
        console.error("[M-CRON] Failed to start worker:", err);
    }
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.1.0 — Added configurable library, watchlist, and free promotion cron schedules]
//   LAST_CHANGE_2: [v2.2.0 - Added configurable perfect-achievement monitoring cron]
//   LAST_CHANGE_3: [v2.3.0 - Store cron task state on globalThis to avoid duplicate jobs across module graphs]
// END_CHANGE_SUMMARY
