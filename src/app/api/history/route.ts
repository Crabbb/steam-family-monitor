// FILE: src/app/api/history/route.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: GET /api/history
//   SCOPE: Fetch notification history logs
//   DEPENDS: M-DB
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { prisma } from "../../../lib/db";

export async function GET() {
    const logs = await prisma.messageHistory.findMany({
        orderBy: { sentAt: 'desc' },
        take: 100
    });
    return NextResponse.json(logs);
}
