// FILE: src/app/api/achievements/test/route.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: POST /api/achievements/test
//   SCOPE: Sends the latest historical perfect-achievement notification for a selected user
//   DEPENDS: M-ACHIEVEMENTS
//   LINKS: M-API, M-ACHIEVEMENTS
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { findLatestPerfectAchievementForUser } from "../../../../lib/achievements";

// START_CONTRACT: POST
//   PURPOSE: Trigger a manual sunflower test notification for one user
//   INPUTS: { Request JSON body with userId }
//   OUTPUTS: { NextResponse JSON with success and appId }
//   SIDE_EFFECTS: Sends Telegram message when a historical perfect game is found
//   LINKS: M-API, M-ACHIEVEMENTS
// END_CONTRACT: POST
export async function POST(req: Request) {
    const body = await req.json();
    const userId = Number.parseInt(String(body.userId || ""), 10);

    if (!Number.isInteger(userId) || userId <= 0) {
        return NextResponse.json({ error: "userId must be a positive integer" }, { status: 400 });
    }

    try {
        const result = await findLatestPerfectAchievementForUser(userId, { sendMessage: true });
        if (!result) {
            return NextResponse.json({ success: false, error: "No perfect achievement games found for this user" }, { status: 404 });
        }

        return NextResponse.json({ success: true, appId: result.appId });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to send perfect achievement test";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added manual latest sunflower test endpoint]
// END_CHANGE_SUMMARY
