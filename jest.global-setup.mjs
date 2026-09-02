import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export default async function globalSetup() {
  const testDir = join(process.cwd(), ".test");
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const dbUrl = "file:./.test/jest.db";
  closeSync(openSync(join(testDir, "jest.db"), "w"));
  process.env.DATABASE_URL = dbUrl;
  process.env.NODE_ENV = "test";

  const result = spawnSync("npx prisma db push", {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "test" },
    shell: true,
    stdio: "pipe",
  });

  if (result.status !== 0) {
    throw new Error(
      `prisma db push failed with exit code ${result.status ?? "unknown"}\n${result.stdout || ""}${result.stderr || ""}`,
    );
  }
}
