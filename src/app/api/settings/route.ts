// FILE: src/app/api/settings/route.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: GET/POST /api/settings
//   SCOPE: Read and update global settings
//   DEPENDS: M-DB
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { prisma } from "../../../lib/db";

export async function GET() {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    return NextResponse.json(settings || {});
}

export async function POST(req: Request) {
    const body = await req.json();
    const checkInterval = parsePositiveInt(body.checkInterval, 15);
    const watchlistIntervalHours = parsePositiveInt(body.watchlistIntervalHours, 12);
    const watchlistMinDiscountPct = parsePositiveInt(body.watchlistMinDiscountPct, 1);
    const freePromosIntervalHours = parsePositiveInt(body.freePromosIntervalHours, 1);
    const freePromosStartHour = parseNonNegativeInt(body.freePromosStartHour, 9);
    const freePromosEndHour = parseNonNegativeInt(body.freePromosEndHour, 23);
    const freePromosSearchCount = parsePositiveInt(body.freePromosSearchCount, 100);
    const achievementIntervalHours = parsePositiveInt(body.achievementIntervalHours, 6);
    const achievementStartHour = parseNonNegativeInt(body.achievementStartHour, 9);
    const achievementEndHour = parseNonNegativeInt(body.achievementEndHour, 23);
    const achievementScanLimit = parsePositiveInt(body.achievementScanLimit, 1000);
    const achievementFullScanIntervalHours = parsePositiveInt(body.achievementFullScanIntervalHours, 24);
    const achievementTestUserId = parseOptionalPositiveInt(body.achievementTestUserId);
    const libraryPollingEnabled = parseBoolean(body.libraryPollingEnabled, true);
    const watchlistEnabled = parseBoolean(body.watchlistEnabled, true);
    const freePromosEnabled = parseBoolean(body.freePromosEnabled, true);
    const freePromosRegionRu = parseBoolean(body.freePromosRegionRu, true);
    const freePromosRegionKz = parseBoolean(body.freePromosRegionKz, true);
    const freePromosSkipOwnedByAll = parseBoolean(body.freePromosSkipOwnedByAll, true);
    const achievementMonitoringEnabled = parseBoolean(body.achievementMonitoringEnabled, true);
    const achievementSteamHuntersEnabled = parseBoolean(body.achievementSteamHuntersEnabled, true);
    const freePromosTimezone = typeof body.freePromosTimezone === "string" && body.freePromosTimezone.trim()
        ? body.freePromosTimezone.trim()
        : "Europe/Samara";
    const achievementTimezone = typeof body.achievementTimezone === "string" && body.achievementTimezone.trim()
        ? body.achievementTimezone.trim()
        : "Europe/Samara";

    if (!Number.isInteger(checkInterval) || checkInterval <= 0) {
        return NextResponse.json({ error: "checkInterval must be a positive integer" }, { status: 400 });
    }
    if (!Number.isInteger(watchlistIntervalHours) || watchlistIntervalHours <= 0 || watchlistIntervalHours > 24) {
        return NextResponse.json({ error: "watchlistIntervalHours must be between 1 and 24" }, { status: 400 });
    }
    if (!Number.isInteger(watchlistMinDiscountPct) || watchlistMinDiscountPct <= 0 || watchlistMinDiscountPct > 100) {
        return NextResponse.json({ error: "watchlistMinDiscountPct must be between 1 and 100" }, { status: 400 });
    }
    if (!Number.isInteger(freePromosIntervalHours) || freePromosIntervalHours <= 0 || freePromosIntervalHours > 24) {
        return NextResponse.json({ error: "freePromosIntervalHours must be between 1 and 24" }, { status: 400 });
    }
    if (!Number.isInteger(freePromosStartHour) || !Number.isInteger(freePromosEndHour)
        || freePromosStartHour < 0 || freePromosStartHour > 23 || freePromosEndHour < 0 || freePromosEndHour > 23) {
        return NextResponse.json({ error: "free promotions hours must be between 0 and 23" }, { status: 400 });
    }
    if (freePromosStartHour > freePromosEndHour) {
        return NextResponse.json({ error: "freePromosStartHour must be less than or equal to freePromosEndHour" }, { status: 400 });
    }
    if (!Number.isInteger(freePromosSearchCount) || freePromosSearchCount <= 0 || freePromosSearchCount > 100) {
        return NextResponse.json({ error: "freePromosSearchCount must be between 1 and 100" }, { status: 400 });
    }
    if (freePromosEnabled && !freePromosRegionRu && !freePromosRegionKz) {
        return NextResponse.json({ error: "at least one free promotions region must be enabled" }, { status: 400 });
    }
    if (!Number.isInteger(achievementIntervalHours) || achievementIntervalHours <= 0 || achievementIntervalHours > 24) {
        return NextResponse.json({ error: "achievementIntervalHours must be between 1 and 24" }, { status: 400 });
    }
    if (!Number.isInteger(achievementStartHour) || !Number.isInteger(achievementEndHour)
        || achievementStartHour < 0 || achievementStartHour > 23 || achievementEndHour < 0 || achievementEndHour > 23) {
        return NextResponse.json({ error: "achievement monitoring hours must be between 0 and 23" }, { status: 400 });
    }
    if (achievementStartHour > achievementEndHour) {
        return NextResponse.json({ error: "achievementStartHour must be less than or equal to achievementEndHour" }, { status: 400 });
    }
    if (!Number.isInteger(achievementScanLimit) || achievementScanLimit <= 0 || achievementScanLimit > 1000) {
        return NextResponse.json({ error: "achievementScanLimit must be between 1 and 1000" }, { status: 400 });
    }
    if (!Number.isInteger(achievementFullScanIntervalHours) || achievementFullScanIntervalHours <= 0 || achievementFullScanIntervalHours > 168) {
        return NextResponse.json({ error: "achievementFullScanIntervalHours must be between 1 and 168" }, { status: 400 });
    }
    if (achievementTestUserId !== null && (!Number.isInteger(achievementTestUserId) || achievementTestUserId <= 0)) {
        return NextResponse.json({ error: "achievementTestUserId must be a positive integer" }, { status: 400 });
    }

    const data = {
        steamApiKey: String(body.steamApiKey || ""),
        telegramToken: String(body.telegramToken || ""),
        telegramChatId: String(body.telegramChatId || ""),
        checkInterval,
        libraryPollingEnabled,
        watchlistEnabled,
        watchlistIntervalHours,
        watchlistMinDiscountPct,
        freePromosEnabled,
        freePromosIntervalHours,
        freePromosStartHour,
        freePromosEndHour,
        freePromosTimezone,
        freePromosRegionRu,
        freePromosRegionKz,
        freePromosSkipOwnedByAll,
        freePromosSearchCount,
        achievementMonitoringEnabled,
        achievementIntervalHours,
        achievementStartHour,
        achievementEndHour,
        achievementTimezone,
        achievementScanLimit,
        achievementFullScanIntervalHours,
        achievementSteamHuntersEnabled,
        achievementTestUserId,
    };

    const settings = await prisma.settings.upsert({
        where: { id: 1 },
        update: data,
        create: data,
    });

    if (process.env.NODE_ENV !== "test") {
        void import("../../../lib/worker").then(({ startWorker }) => startWorker());
    }

    return NextResponse.json(settings);
}

function parsePositiveInt(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    return Number.parseInt(String(value), 10);
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === "") return fallback;
    return Number.parseInt(String(value), 10);
}

function parseOptionalPositiveInt(value: unknown): number | null {
    if (value === undefined || value === null || value === "") return null;
    return Number.parseInt(String(value), 10);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.toLowerCase() === "true";
    return Boolean(value);
}
