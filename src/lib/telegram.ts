// FILE: src/lib/telegram.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Sends formatted HTML messages to Telegram, supports reply markup and callback queries
//   SCOPE: Provides functions to dispatch messages, reply with inline keyboards, and answer callbacks
//   DEPENDS: none
//   LINKS: M-TG
// END_MODULE_CONTRACT

type TelegramPayload = {
    chat_id: string | number;
    parse_mode: "HTML";
    text?: string;
    photo?: string;
    caption?: string;
    disable_web_page_preview?: boolean;
    reply_markup?: object;
};

// START_CONTRACT: sendTelegramMessage
//   PURPOSE: Send HTML message to configured chat
//   INPUTS: { htmlMessage: string - The formatted HTML, chatId: string - Target chat ID, botToken: string - Telegram API token }
//   OUTPUTS: { Promise<boolean> - True if successful }
//   SIDE_EFFECTS: HTTP POST to api.telegram.org
//   LINKS: M-TG
// END_CONTRACT: sendTelegramMessage
export async function sendTelegramMessage(
    htmlMessage: string,
    chatId: string,
    botToken: string,
    imageUrl?: string
): Promise<boolean> {
    if (!botToken || !chatId) {
        console.error("[M-TG] Missing bot token or chat ID");
        return false;
    }

    let url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    let payload: TelegramPayload = {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
        disable_web_page_preview: true,
    };

    if (imageUrl) {
        url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
        payload = {
            chat_id: chatId,
            photo: imageUrl,
            caption: htmlMessage,
            parse_mode: "HTML",
        };
    }

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            console.error(`[M-TG] Telegram API error: ${res.statusText}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`[M-TG] Failed to send Telegram message:`, error);
        return false;
    }
}

export async function sendTelegramReply(
    chatId: number | string,
    text: string,
    botToken: string,
    options?: { replyMarkup?: object; imageUrl?: string },
): Promise<boolean> {
    if (!botToken || !chatId) return false;

    let url: string;
    let payload: TelegramPayload;

    if (options?.imageUrl) {
        url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
        payload = {
            chat_id: chatId,
            photo: options.imageUrl,
            caption: text,
            parse_mode: "HTML",
        };
    } else {
        url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        payload = {
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
        };
    }

    if (options?.replyMarkup) {
        payload.reply_markup = options.replyMarkup;
    }

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.text();
            console.error(`[M-TG] sendTelegramReply error: ${res.status} ${body}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error("[M-TG] sendTelegramReply failed:", error);
        return false;
    }
}

export async function answerCallbackQuery(
    callbackQueryId: string,
    botToken: string,
    text?: string,
): Promise<boolean> {
    try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
        });
        return res.ok;
    } catch {
        return false;
    }
}
