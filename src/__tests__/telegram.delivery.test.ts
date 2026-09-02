// FILE: src/__tests__/telegram.delivery.test.ts
// VERSION: 1.0.0

import { sendTelegramMessage, sendTelegramReply, TELEGRAM_CAPTION_LIMIT } from "../lib/telegram";

global.fetch = jest.fn();

function okResponse() {
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
}

function errorResponse(status: number, body: object = {}) {
    return {
        ok: false,
        status,
        statusText: `status ${status}`,
        json: async () => ({ ok: false, ...body }),
        text: async () => JSON.stringify({ ok: false, ...body }),
    };
}

function callsTo(method: string) {
    return (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).endsWith(`/${method}`));
}

describe("M-TG: delivery policy", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("sends the photo without a caption and the text separately when the caption limit is exceeded", async () => {
        const longHtml = `<b>Game</b> ${"описание ".repeat(200)}`;
        expect(longHtml.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
        (global.fetch as jest.Mock).mockResolvedValue(okResponse());

        const sent = await sendTelegramMessage(longHtml, "chat", "token", "https://cdn/header.jpg");

        expect(sent).toBe(true);
        expect(callsTo("sendPhoto")).toHaveLength(1);
        expect(callsTo("sendMessage")).toHaveLength(1);

        const photoBody = JSON.parse(callsTo("sendPhoto")[0][1].body);
        expect(photoBody.photo).toBe("https://cdn/header.jpg");
        expect(photoBody.caption).toBeUndefined();

        const textBody = JSON.parse(callsTo("sendMessage")[0][1].body);
        expect(textBody.text).toBe(longHtml);
    });

    it("reports failure when the oversized-caption photo succeeds but the text does not", async () => {
        const longHtml = `<b>Game</b> ${"описание ".repeat(200)}`;
        expect(longHtml.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce(errorResponse(400, { description: "message is too long" }));

        const sent = await sendTelegramMessage(longHtml, "chat", "token", "https://cdn/header.jpg");

        expect(sent).toBe(false);
        expect(callsTo("sendPhoto")).toHaveLength(1);
        expect(callsTo("sendMessage")).toHaveLength(1);
    });

    it("reports success when the oversized-caption text succeeds even if the photo does not", async () => {
        const longHtml = `<b>Game</b> ${"описание ".repeat(200)}`;
        expect(longHtml.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(errorResponse(400, { description: "wrong file identifier" }))
            .mockResolvedValueOnce(okResponse());

        const sent = await sendTelegramMessage(longHtml, "chat", "token", "https://cdn/header.jpg");

        expect(sent).toBe(true);
        expect(callsTo("sendPhoto")).toHaveLength(1);
        expect(callsTo("sendMessage")).toHaveLength(1);
    });

    it("falls back to a text message when Telegram rejects the photo", async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(errorResponse(400, { description: "wrong file identifier" }))
            .mockResolvedValueOnce(okResponse());

        const sent = await sendTelegramMessage("<b>Короткое</b>", "chat", "token", "https://cdn/broken.jpg");

        expect(sent).toBe(true);
        expect(callsTo("sendPhoto")).toHaveLength(1);
        expect(callsTo("sendMessage")).toHaveLength(1);
        expect(JSON.parse(callsTo("sendMessage")[0][1].body).text).toBe("<b>Короткое</b>");
    });

    it("retries a 429 after the delay Telegram asks for", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(errorResponse(429, { parameters: { retry_after: 2 } }))
            .mockResolvedValueOnce(okResponse());

        const pending = sendTelegramMessage("<b>Привет</b>", "chat", "token");

        // Let the first attempt run and register its retry timer, without letting that timer
        // fire — proves the second call waits for the delay rather than firing immediately.
        await jest.advanceTimersByTimeAsync(0);
        expect(callsTo("sendMessage")).toHaveLength(1);

        await jest.advanceTimersByTimeAsync(2100);
        const sent = await pending;

        expect(sent).toBe(true);
        expect(callsTo("sendMessage")).toHaveLength(2);
        jest.useRealTimers();
    });

    it("gives up after three attempts on repeated server errors", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock).mockResolvedValue(errorResponse(503));

        const pending = sendTelegramMessage("<b>Привет</b>", "chat", "token");
        await jest.advanceTimersByTimeAsync(10000);
        const sent = await pending;

        expect(sent).toBe(false);
        expect(callsTo("sendMessage")).toHaveLength(3);
        jest.useRealTimers();
    });

    it("does not retry a client error other than 429", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(errorResponse(400, { description: "chat not found" }));

        const sent = await sendTelegramMessage("<b>Привет</b>", "chat", "token");

        expect(sent).toBe(false);
        expect(callsTo("sendMessage")).toHaveLength(1);
    });

    it("retries sendTelegramReply on a 5xx and still delivers the keyboard", async () => {
        jest.useFakeTimers();
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce(errorResponse(500))
            .mockResolvedValueOnce(okResponse());

        const keyboard = { inline_keyboard: [[{ text: "Pick", callback_data: "price:730" }]] };
        const pending = sendTelegramReply(123, "Choose", "token", { replyMarkup: keyboard });
        await jest.advanceTimersByTimeAsync(1000);
        const sent = await pending;

        expect(sent).toBe(true);
        expect(callsTo("sendMessage")).toHaveLength(2);
        const body = JSON.parse(callsTo("sendMessage")[1][1].body);
        expect(body.reply_markup).toEqual(keyboard);
        jest.useRealTimers();
    });
});
