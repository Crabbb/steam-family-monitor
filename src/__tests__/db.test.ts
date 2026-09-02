// FILE: src/__tests__/db.test.ts
// VERSION: 1.0.0

import { prisma } from "../lib/db";

describe("M-DB: Database Layer", () => {
    beforeAll(async () => {
        // Ensure the settings row exists
        await prisma.settings.upsert({
            where: { id: 1 },
            update: {},
            create: {
                steamApiKey: "test-steam-key",
                telegramToken: "test-tg-token",
                telegramChatId: "-100123456",
                checkInterval: 10,
            },
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it("should retrieve global settings", async () => {
        const settings = await prisma.settings.findUnique({
            where: { id: 1 },
        });
        expect(settings).toBeDefined();
        expect(settings?.id).toBe(1);
        expect(typeof settings?.steamApiKey).toBe("string");
    });

    it("should update global settings", async () => {
        const updated = await prisma.settings.update({
            where: { id: 1 },
            data: { checkInterval: 20 },
        });
        expect(updated.checkInterval).toBe(20);
    });
});
