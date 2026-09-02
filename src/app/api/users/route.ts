// FILE: src/app/api/users/route.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: GET/POST /api/users
//   SCOPE: Read and create monitored users
//   DEPENDS: M-DB
//   LINKS: M-API
// END_MODULE_CONTRACT

import { NextResponse } from "next/server";
import { prisma } from "../../../lib/db";

function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function GET() {
    const users = await prisma.user.findMany({
        include: { _count: { select: { games: true } } }
    });
    return NextResponse.json(users);
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const steamId = typeof body.steamId === "string" ? body.steamId.trim() : "";

        if (!name || !steamId) {
            return NextResponse.json({ error: "name and steamId are required" }, { status: 400 });
        }

        const user = await prisma.user.create({
            data: {
                name,
                steamId,
            },
        });
        return NextResponse.json(user);
    } catch (error: unknown) {
        if (isUniqueConstraintError(error)) {
            return NextResponse.json({ error: "Steam ID already exists" }, { status: 400 });
        }
        return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
    }
}
