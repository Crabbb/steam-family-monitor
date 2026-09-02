// FILE: src/lib/db.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Manages SQLite connection and provides Prisma ORM access
//   SCOPE: Initializes and exports a singleton PrismaClient instance
//   DEPENDS: none
//   LINKS: M-DB
// END_MODULE_CONTRACT

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

// START_CONTRACT: prisma
//   PURPOSE: Global PrismaClient instance
//   INPUTS: {}
//   OUTPUTS: { PrismaClient - The connected database client }
//   SIDE_EFFECTS: Connects to the SQLite database
//   LINKS: M-DB
// END_CONTRACT: prisma

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

// START_BLOCK_INITIALIZE_PRISMA
const dbUrl = process.env.DATABASE_URL || "file:./dev.db";
const adapter = new PrismaLibSql({
    url: dbUrl,
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}
// END_BLOCK_INITIALIZE_PRISMA
