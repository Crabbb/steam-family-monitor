// FILE: src/__tests__/telegram.test.ts
// VERSION: 1.0.0

import { answerCallbackQuery, sendTelegramMessage, sendTelegramReply } from "../lib/telegram";

// Mock global fetch
global.fetch = jest.fn();

describe("M-TG: Telegram Client", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("sendMessage should post HTML payload to Telegram Bot API", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                ok: true,
                result: { message_id: 123 }
            })
        });

        const success = await sendTelegramMessage("<b>Hello</b>", "test-chat-id", "test-bot-token");
        expect(success).toBe(true);

        // Verify fetch arguments
        expect(global.fetch).toHaveBeenCalledTimes(1);

        const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = JSON.parse(options.body);
        expect(body.chat_id).toBe("test-chat-id");
        expect(body.text).toBe("<b>Hello</b>");
        expect(body.parse_mode).toBe("HTML");
        expect(body.disable_web_page_preview).toBe(true);
    });

    it("sendMessage should return false if response is not ok", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            statusText: "Bad Request"
        });

        const success = await sendTelegramMessage("<b>Hello</b>", "test-chat-id", "test-bot-token");
        expect(success).toBe(false);
    });

    it("sendMessage should send photos when an image URL is provided", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ok: true }),
        });

        const success = await sendTelegramMessage("<b>Hello</b>", "chat", "token", "https://cdn/image.jpg");

        expect(success).toBe(true);
        const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe("https://api.telegram.org/bottoken/sendPhoto");
        expect(JSON.parse(options.body)).toMatchObject({
            chat_id: "chat",
            photo: "https://cdn/image.jpg",
            caption: "<b>Hello</b>",
        });
    });

    it("sendTelegramReply should include inline keyboards", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ok: true }),
        });

        const keyboard = { inline_keyboard: [[{ text: "Pick", callback_data: "price:730" }]] };
        const success = await sendTelegramReply(123, "Choose", "token", { replyMarkup: keyboard });

        expect(success).toBe(true);
        const [, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(JSON.parse(options.body)).toMatchObject({
            chat_id: 123,
            text: "Choose",
            reply_markup: keyboard,
        });
    });

    it("answerCallbackQuery should return Telegram API status", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

        const success = await answerCallbackQuery("callback-id", "token", "Done");

        expect(success).toBe(true);
        const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe("https://api.telegram.org/bottoken/answerCallbackQuery");
        expect(JSON.parse(options.body)).toEqual({ callback_query_id: "callback-id", text: "Done" });
    });
});
