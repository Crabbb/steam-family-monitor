// FILE: src/app/api/users/[id]/route.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: DELETE /api/users/[id]
//   SCOPE: Delete a monitored user
//   DEPENDS: M-DB
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/db";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const resolvedParams = await params;
        await prisma.user.delete({
            where: { id: parseInt(resolvedParams.id, 10) }
        });
        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: "Failed to delete user" }, { status: 500 });
    }
}
