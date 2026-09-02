// FILE: src/app/api/test-message/route.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: POST /api/test-message
//   SCOPE: Trigger a test notification for a user
//   DEPENDS: M-CORE
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { sendTestMessage } from "../../../lib/core";

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Failed to send test message";
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const userId = Number.parseInt(String(body.userId), 10);

        if (!Number.isInteger(userId) || userId <= 0) {
            return NextResponse.json({ error: "userId must be a positive integer" }, { status: 400 });
        }

        await sendTestMessage(userId);
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("Test message error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
