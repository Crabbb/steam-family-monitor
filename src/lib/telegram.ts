// FILE: src/lib/telegram.ts
// VERSION: 2.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Sends formatted HTML messages to Telegram, supports reply markup and callback queries
//   SCOPE: Provides functions to dispatch messages, reply with inline keyboards, and answer callbacks.
//          Delivery policy: split oversized captions into photo-then-text, fall back from a
//          rejected photo to plain text, and retry transient (429/5xx) failures before giving up.
//   DEPENDS: none
//   LINKS: M-TG
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   sendTelegramMessage — Send an HTML message to the configured chat, applying the delivery policy
//   sendTelegramReply — Send a reply, optionally with an inline keyboard or image; shares the retry policy only, not the oversized-caption split or photo-rejected fallback
//   sendPlainText — Send the plain-text sendMessage variant shared by every sendTelegramMessage call site
//   answerCallbackQuery — Acknowledge a Telegram callback query
//   postToTelegram — Make one Bot API call with retry on 429/5xx
// END_MODULE_MAP

type TelegramPayload = {
    chat_id: string | number;
    parse_mode: "HTML";
    text?: string;
    photo?: string;
    caption?: string;
    disable_web_page_preview?: boolean;
    reply_markup?: object;
};

export const TELEGRAM_CAPTION_LIMIT = 1024;

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
    imageUrl?: string,
): Promise<boolean> {
    if (!botToken || !chatId) {
        console.error("[M-TG] Missing bot token or chat ID");
        return false;
    }

    // START_BLOCK_SEND_WITHIN_LIMITS
    // Telegram allows 1024 chars in a caption but 4096 in a message. Cutting HTML would tear
    // tags apart, so an oversized message travels as photo-then-text instead.
    if (imageUrl && htmlMessage.length > TELEGRAM_CAPTION_LIMIT) {
        // The photo carries no informational value on its own here (its caption was dropped
        // for length), so its result is not awaited into the return value below.
        await postToTelegram(botToken, "sendPhoto", {
            chat_id: chatId,
            photo: imageUrl,
            parse_mode: "HTML",
        });
        // The text carries the content; the photo is decoration. Reporting success when the
        // text failed would let core.ts mark the game notified while the reader saw only a cover.
        return sendPlainText(botToken, chatId, htmlMessage);
    }
    // END_BLOCK_SEND_WITHIN_LIMITS

    if (imageUrl) {
        const photoSent = await postToTelegram(botToken, "sendPhoto", {
            chat_id: chatId,
            photo: imageUrl,
            caption: htmlMessage,
            parse_mode: "HTML",
        });
        if (photoSent) return true;

        // Broken cover, oversized caption Telegram counted differently, image host down:
        // the message matters more than the picture.
        console.warn("[M-TG] sendPhoto failed, retrying as plain message");
        return sendPlainText(botToken, chatId, htmlMessage);
    }

    return sendPlainText(botToken, chatId, htmlMessage);
}

// START_CONTRACT: sendPlainText
//   PURPOSE: Send the plain-text sendMessage variant of the delivery policy, shared by every call site that needs it
//   INPUTS: { botToken: string - Telegram bot token, chatId: string | number - Target chat ID, htmlMessage: string - The formatted HTML }
//   OUTPUTS: { Promise<boolean> - True only if Telegram accepted the message within TELEGRAM_MAX_ATTEMPTS tries }
//   SIDE_EFFECTS: HTTP POST to api.telegram.org via postToTelegram
//   LINKS: M-TG
// END_CONTRACT: sendPlainText
function sendPlainText(botToken: string, chatId: string | number, htmlMessage: string): Promise<boolean> {
    return postToTelegram(botToken, "sendMessage", {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
        disable_web_page_preview: true,
    });
}

const TELEGRAM_MAX_ATTEMPTS = 3;

// START_CONTRACT: retryDelayMs
//   PURPOSE: Decide whether a failed Telegram call is worth retrying, and after how long
//   INPUTS: { res: { status: number } - Telegram HTTP response, retryAfterSeconds: number | undefined - Telegram's requested cooldown, attempt: number - 1-based attempt count }
//   OUTPUTS: { number | null - Delay in ms before the next attempt, or null when the error is not retryable }
//   SIDE_EFFECTS: none
//   LINKS: M-TG
// END_CONTRACT: retryDelayMs
function retryDelayMs(res: { status: number }, retryAfterSeconds: number | undefined, attempt: number): number | null {
    if (res.status === 429) return Math.max(1, retryAfterSeconds ?? 1) * 1000;
    if (res.status >= 500) return 500 * 2 ** (attempt - 1);
    return null; // retrying any 4xx other than 429 is pointless
}

// START_CONTRACT: postToTelegram
//   PURPOSE: Make one logical Telegram Bot API call, retrying transient failures
//   INPUTS: { botToken: string - Telegram bot token, method: string - Bot API method name, payload: TelegramPayload - JSON body }
//   OUTPUTS: { Promise<boolean> - True only if Telegram accepted the call within TELEGRAM_MAX_ATTEMPTS tries }
//   SIDE_EFFECTS: HTTP POST to api.telegram.org, may sleep between attempts via setTimeout
//   LINKS: M-TG
// END_CONTRACT: postToTelegram
async function postToTelegram(botToken: string, method: string, payload: TelegramPayload): Promise<boolean> {
    // START_BLOCK_POST_WITH_RETRY
    for (let attempt = 1; attempt <= TELEGRAM_MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (res.ok) return true;

            const body = await readTelegramError(res);
            const delay = typeof res.status === "number"
                ? retryDelayMs(res as { status: number }, body?.parameters?.retry_after, attempt)
                : null;

            console.error(`[M-TG] ${method} failed: ${res.status ?? "?"} ${body?.description ?? res.statusText}`);
            if (delay === null || attempt === TELEGRAM_MAX_ATTEMPTS) return false;

            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (error) {
            console.error(`[M-TG] ${method} threw on attempt ${attempt}:`, error);
            if (attempt === TELEGRAM_MAX_ATTEMPTS) return false;
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
    }
    return false;
    // END_BLOCK_POST_WITH_RETRY
}

// START_CONTRACT: readTelegramError
//   PURPOSE: Best-effort parse of a failed Telegram API response body
//   INPUTS: { res: { json?: () => Promise<unknown> } - Telegram HTTP response }
//   OUTPUTS: { Promise<{ description?: string, parameters?: { retry_after?: number } } | null> - Parsed error body, or null if absent/unparsable }
//   SIDE_EFFECTS: none
//   LINKS: M-TG
// END_CONTRACT: readTelegramError
async function readTelegramError(res: { json?: () => Promise<unknown> }): Promise<
    { description?: string; parameters?: { retry_after?: number } } | null
> {
    try {
        return res.json ? await res.json() as { description?: string; parameters?: { retry_after?: number } } : null;
    } catch {
        return null;
    }
}

// START_CONTRACT: sendTelegramReply
//   PURPOSE: Send a reply to a chat, optionally with an inline keyboard or image
//   INPUTS: { chatId: number | string - Target chat ID, text: string - The formatted HTML, botToken: string - Telegram API token, options: { replyMarkup?: object, imageUrl?: string } }
//   OUTPUTS: { Promise<boolean> - True if successful }
//   SIDE_EFFECTS: HTTP POST to api.telegram.org
//   LINKS: M-TG
// END_CONTRACT: sendTelegramReply
export async function sendTelegramReply(
    chatId: number | string,
    text: string,
    botToken: string,
    options?: { replyMarkup?: object; imageUrl?: string },
): Promise<boolean> {
    if (!botToken || !chatId) return false;

    const method = options?.imageUrl ? "sendPhoto" : "sendMessage";
    const payload: TelegramPayload = options?.imageUrl
        ? { chat_id: chatId, photo: options.imageUrl, caption: text, parse_mode: "HTML" }
        : { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };

    if (options?.replyMarkup) {
        payload.reply_markup = options.replyMarkup;
    }

    return postToTelegram(botToken, method, payload);
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

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.1.0 - Split oversized captions, fall back to text when a photo is rejected, retry 429/5xx]
//   LAST_CHANGE_2: [v2.2.0 - Oversized-caption path now reports success only when the text lands; a captionless photo alone is no longer counted as delivered]
//   LAST_CHANGE_3: [v2.3.0 - Extracted sendPlainText to remove the triplicated plain-text sendMessage call; comments translated to English]
// END_CHANGE_SUMMARY
