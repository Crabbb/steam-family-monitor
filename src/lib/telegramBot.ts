// FILE: src/lib/telegramBot.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Telegram Bot long-polling loop with a command registry that drives both routing and /help
//   SCOPE: Receives incoming messages via getUpdates, routes commands through BOT_COMMANDS, handles inline keyboard callbacks
//   DEPENDS: M-TG, M-STEAM, M-PRICECARD, M-DB
//   LINKS: M-TGBOT
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   startTelegramBot — Start the getUpdates long-polling loop
//   stopTelegramBot — Stop the getUpdates long-polling loop
//   BOT_COMMANDS — Registry of every answered command: name, aliases, args, description, handler
//   resolveCommand — Resolve an incoming command name or alias to its spec
//   buildHelpMessage — Render the /help listing from the registry
// END_MODULE_MAP

import { prisma } from "./db";
import { searchSteamGames, getAppDetails } from "./steam";
import { buildPriceCard, formatPriceCardHtml } from "./pricecard";
import { sendTelegramReply, answerCallbackQuery } from "./telegram";

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        chat: { id: number };
        text?: string;
        from?: { id: number; first_name: string };
    };
    callback_query?: {
        id: string;
        message?: { chat: { id: number }; message_id: number };
        data?: string;
    };
}

interface TelegramBotState {
    running: boolean;
    offset: number;
}

const globalForTelegramBot = globalThis as typeof globalThis & {
    steamMonitorTelegramBotState?: TelegramBotState;
};

const botState = globalForTelegramBot.steamMonitorTelegramBotState ??= {
    running: false,
    offset: 0,
};

// START_CONTRACT: BOT_COMMANDS
//   PURPOSE: Single source of truth for every command the bot answers and for the /help listing
//   INPUTS: none
//   OUTPUTS: { BotCommandSpec[] — name, aliases, argument hint, description, handler }
//   SIDE_EFFECTS: none
//   LINKS: M-TGBOT
// END_CONTRACT: BOT_COMMANDS
export interface BotCommandSpec {
    name: string;
    aliases?: string[];
    args?: string;
    description: string;
    handler: (chatId: number, args: string, token: string) => Promise<void>;
}

export const BOT_COMMANDS: BotCommandSpec[] = [
    {
        name: "price",
        args: "название или appId",
        description: "цены Steam RU и KZ, Plati.ru и поддержка семейной библиотеки",
        handler: handlePriceCommand,
    },
    {
        name: "watch",
        args: "название или appId",
        description: "следить за скидками на игру",
        handler: handleWatchCommand,
    },
    {
        name: "unwatch",
        args: "название или appId",
        description: "убрать игру из отслеживания",
        handler: handleUnwatchCommand,
    },
    {
        name: "watchlist",
        description: "показать список отслеживаемых игр",
        handler: handleWatchlistCommand,
    },
    {
        name: "help",
        aliases: ["start"],
        description: "показать этот список команд",
        handler: handleHelpCommand,
    },
];

// START_CONTRACT: resolveCommand
//   PURPOSE: Find the command spec for an incoming command name or alias
//   INPUTS: { name: string — command name without the leading slash }
//   OUTPUTS: { BotCommandSpec | undefined }
//   SIDE_EFFECTS: none
//   LINKS: M-TGBOT
// END_CONTRACT: resolveCommand
export function resolveCommand(name: string): BotCommandSpec | undefined {
    const normalized = name.toLowerCase();
    return BOT_COMMANDS.find(spec => spec.name === normalized || spec.aliases?.includes(normalized));
}

// START_CONTRACT: buildHelpMessage
//   PURPOSE: Render the /help listing from the command registry so it can never drift from the routing
//   INPUTS: none
//   OUTPUTS: { string — Telegram HTML }
//   SIDE_EFFECTS: none
//   LINKS: M-TGBOT
// END_CONTRACT: buildHelpMessage
export function buildHelpMessage(): string {
    // START_BLOCK_BUILD_HELP
    let msg = `🤖 <b>Steam Monitor Bot</b>\n\n<b>Доступные команды:</b>\n`;

    for (const spec of BOT_COMMANDS) {
        msg += `/${spec.name}`;
        if (spec.args) msg += ` <i>${spec.args}</i>`;
        msg += ` — ${spec.description}`;
        if (spec.aliases?.length) {
            msg += ` (то же самое: ${spec.aliases.map(alias => `/${alias}`).join(", ")})`;
        }
        msg += `\n`;
    }

    msg += `\nЦены показываются для регионов RU и KZ (с пересчётом в ₽ по курсу ЦБ РФ), а также с Plati.ru.`;
    return msg;
    // END_BLOCK_BUILD_HELP
}

function isPollingTimeout(error: unknown): boolean {
    return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export async function startTelegramBot(): Promise<void> {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.telegramToken) {
        console.warn("[M-TGBOT] No Telegram token configured, bot not started");
        return;
    }

    if (botState.running) {
        console.log("[M-TGBOT] Bot already running");
        return;
    }

    botState.running = true;
    const token = settings.telegramToken;
    console.log("[M-TGBOT] Starting long-polling...");

    while (botState.running) {
        try {
            const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${botState.offset}&timeout=30`;
            const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
            const data = await res.json();

            if (data.ok && data.result?.length > 0) {
                for (const update of data.result as TelegramUpdate[]) {
                    botState.offset = update.update_id + 1;
                    try {
                        await handleUpdate(update, token);
                    } catch (err) {
                        console.error("[M-TGBOT] Error handling update:", err);
                    }
                }
            }
        } catch (err: unknown) {
            if (isPollingTimeout(err)) continue;
            console.error("[M-TGBOT] Polling error, retrying in 5s:", err);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

export function stopTelegramBot(): void {
    botState.running = false;
    console.log("[M-TGBOT] Stop requested");
}

async function handleUpdate(update: TelegramUpdate, token: string) {
    // Handle callback queries (inline keyboard buttons)
    if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message?.chat.id;
        const data = cb.data;
        if (!chatId || !data) return;

        await answerCallbackQuery(cb.id, token);

        if (data.startsWith("price:")) {
            const appId = data.slice(6);
            await handlePriceByAppId(chatId, appId, token);
        } else if (data.startsWith("watch:")) {
            const appId = data.slice(6);
            await handleWatchByAppId(chatId, appId, token);
        }
        return;
    }

    // Handle text messages
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Parse command: /command@botname args
    const match = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)?$/);
    if (!match) return;

    const command = match[1].toLowerCase();
    const args = (match[2] || "").trim();

    const spec = resolveCommand(command);
    if (!spec) return;

    await spec.handler(chatId, args, token);
}

// ─── Command Handlers ──────────────────────────────────────────

async function handlePriceCommand(chatId: number, query: string, token: string) {
    if (!query) {
        await sendTelegramReply(chatId, "Использование: <code>/price название игры</code> или <code>/price appId</code>", token);
        return;
    }

    const results = await searchSteamGames(query);
    if (results.length === 0) {
        await sendTelegramReply(chatId, "Ничего не найдено.", token);
        return;
    }

    if (results.length === 1) {
        await handlePriceByAppId(chatId, results[0].appId, token);
        return;
    }

    // Multiple results — send inline keyboard
    const keyboard = {
        inline_keyboard: results.map(r => [{ text: r.name || `App ${r.appId}`, callback_data: `price:${r.appId}` }]),
    };
    await sendTelegramReply(chatId, "Найдено несколько игр. Выберите:", token, { replyMarkup: keyboard });
}

async function handlePriceByAppId(chatId: number, appId: string, token: string) {
    await sendTelegramReply(chatId, "⏳ Загрузка цен...", token);

    const card = await buildPriceCard(appId);
    if (!card) {
        await sendTelegramReply(chatId, `Не удалось получить данные для App ${appId}.`, token);
        return;
    }

    const html = formatPriceCardHtml(card);
    await sendTelegramReply(chatId, html, token, { imageUrl: card.headerImage });
}

async function handleWatchCommand(chatId: number, query: string, token: string) {
    if (!query) {
        await sendTelegramReply(chatId, "Использование: <code>/watch название игры</code> или <code>/watch appId</code>", token);
        return;
    }

    const results = await searchSteamGames(query);
    if (results.length === 0) {
        await sendTelegramReply(chatId, "Ничего не найдено.", token);
        return;
    }

    if (results.length === 1) {
        await handleWatchByAppId(chatId, results[0].appId, token);
        return;
    }

    // Multiple results — inline keyboard
    const keyboard = {
        inline_keyboard: results.map(r => [{ text: r.name || `App ${r.appId}`, callback_data: `watch:${r.appId}` }]),
    };
    await sendTelegramReply(chatId, "Найдено несколько игр. Выберите для отслеживания:", token, { replyMarkup: keyboard });
}

async function handleWatchByAppId(chatId: number, appId: string, token: string) {
    // Resolve name: try RU → global → KZ
    let name = "";
    const details = await getAppDetails(appId, "ru");
    if (details) {
        name = details.name;
    } else {
        const globalDetails = await getAppDetails(appId, "");
        if (globalDetails) {
            name = globalDetails.name;
        } else {
            const kzDetails = await getAppDetails(appId, "kz");
            name = kzDetails?.name || `App ${appId}`;
        }
    }

    const chatIdStr = String(chatId);

    // Check if already watched
    const existing = await prisma.watchedGame.findUnique({
        where: { appId_chatId: { appId, chatId: chatIdStr } },
    });

    if (existing) {
        await sendTelegramReply(chatId, `<b>${name}</b> уже в списке отслеживания.`, token);
        return;
    }

    await prisma.watchedGame.create({
        data: { appId, name, chatId: chatIdStr },
    });

    await sendTelegramReply(chatId, `✅ <b>${name}</b> добавлена в отслеживание скидок.`, token);

    // Send current price card as confirmation
    const card = await buildPriceCard(appId);
    if (card) {
        const html = formatPriceCardHtml(card);
        await sendTelegramReply(chatId, html, token, { imageUrl: card.headerImage });
    }
}

async function handleUnwatchCommand(chatId: number, query: string, token: string) {
    if (!query) {
        await sendTelegramReply(chatId, "Использование: <code>/unwatch название игры</code> или <code>/unwatch appId</code>", token);
        return;
    }

    const chatIdStr = String(chatId);

    // If query is numeric, treat as appId directly
    if (/^\d+$/.test(query.trim())) {
        const appId = query.trim();
        try {
            await prisma.watchedGame.delete({
                where: { appId_chatId: { appId, chatId: chatIdStr } },
            });
            await sendTelegramReply(chatId, `❌ App ${appId} удалена из отслеживания.`, token);
        } catch {
            await sendTelegramReply(chatId, `App ${appId} не найдена в списке отслеживания.`, token);
        }
        return;
    }

    // Search by name among watched games
    const watched = await prisma.watchedGame.findMany({ where: { chatId: chatIdStr } });
    const queryLower = query.toLowerCase();
    const match = watched.find(w => w.name.toLowerCase().includes(queryLower));

    if (!match) {
        await sendTelegramReply(chatId, `Игра "${query}" не найдена в списке отслеживания.`, token);
        return;
    }

    await prisma.watchedGame.delete({ where: { id: match.id } });
    await sendTelegramReply(chatId, `❌ <b>${match.name}</b> удалена из отслеживания.`, token);
}

async function handleWatchlistCommand(chatId: number, args: string, token: string) {
    const chatIdStr = String(chatId);
    const watched = await prisma.watchedGame.findMany({
        where: { chatId: chatIdStr },
        orderBy: { addedAt: "desc" },
    });

    if (watched.length === 0) {
        await sendTelegramReply(chatId, "Список отслеживания пуст.\n\nДобавьте игру: <code>/watch название</code>", token);
        return;
    }

    let msg = `📋 <b>Отслеживание скидок (${watched.length}):</b>\n\n`;
    watched.forEach((w, i) => {
        msg += `${i + 1}. <a href="https://store.steampowered.com/app/${w.appId}">${w.name}</a>`;
        if (w.lastDiscountPct > 0) {
            msg += ` 🏷 -${w.lastDiscountPct}%`;
        }
        msg += `\n`;
    });

    msg += `\nУдалить: <code>/unwatch appId</code>`;
    await sendTelegramReply(chatId, msg, token);
}

async function handleHelpCommand(chatId: number, args: string, token: string) {
    await sendTelegramReply(chatId, buildHelpMessage(), token);
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.1.0 - Store polling state on globalThis to avoid duplicate long-polling loops]
//   LAST_CHANGE_2: [v2.2.0 - Route commands through BOT_COMMANDS registry so /help always lists every answered command]
// END_CHANGE_SUMMARY
