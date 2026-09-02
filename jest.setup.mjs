process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "file:./.test/jest.db";
process.env.STEAM_MIN_INTERVAL_MS = "0";
