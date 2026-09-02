// FILE: src/lib/pricecard.ts
// VERSION: 2.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Builds unified price cards for /price commands and watchlist alerts
//   SCOPE: Aggregates Steam RU/KZ prices, CBR conversion, plati.ru, family library support — formats as Telegram HTML
//   DEPENDS: M-STEAM, M-CBR, M-PLATI
//   LINKS: M-PRICECARD
// END_MODULE_CONTRACT

import { detectFamilySharing, FamilySharingSupport, getAppDetails, SteamAppDetails } from "./steam";
import { getKztRate, convertKztToRub } from "./cbr";
import { getPlatiCheapest, PlatiResult } from "./plati";

export interface PriceCardData {
    appId: string;
    name: string;
    headerImage?: string;
    // RU
    priceRuFormatted: string | null; // null = region-blocked
    priceRuFinal: number | null;     // kopecks
    discountPctRu: number;
    // KZ
    priceKzFormatted: string | null;
    priceKzFinal: number | null;     // tiyn
    priceKzInRub: number | null;     // converted, whole rubles
    // Plati
    platiName: string | null;
    platiPriceRub: number | null;
    platiUrl: string | null;
    // Meta
    isFree: boolean;
    familySharing: FamilySharingSupport;
}

const FAMILY_SHARING_LABELS: Record<FamilySharingSupport, string> = {
    supported: "Доступно",
    unsupported: "Недоступно",
    unknown: "Нет данных",
};

// START_CONTRACT: formatFamilySharing
//   PURPOSE: Render family library support as the single Russian label used across all Telegram messages
//   INPUTS: { support: FamilySharingSupport }
//   OUTPUTS: { string — "Доступно" | "Недоступно" | "Нет данных" }
//   SIDE_EFFECTS: none
//   LINKS: M-PRICECARD, M-CORE
// END_CONTRACT: formatFamilySharing
export function formatFamilySharing(support: FamilySharingSupport): string {
    return FAMILY_SHARING_LABELS[support];
}

// START_CONTRACT: resolveFamilySharing
//   PURPOSE: Pick family sharing support from the first region that actually returned categories
//   INPUTS: { sources: (SteamAppDetails | null)[] — regional app details in priority order }
//   OUTPUTS: { FamilySharingSupport }
//   SIDE_EFFECTS: none
//   LINKS: M-PRICECARD, M-STEAM
// END_CONTRACT: resolveFamilySharing
function resolveFamilySharing(...sources: (SteamAppDetails | null)[]): FamilySharingSupport {
    // Category 62 is region-independent, so the first region with categories is authoritative.
    for (const source of sources) {
        const support = detectFamilySharing(source);
        if (support !== "unknown") return support;
    }

    return "unknown";
}

const PLATI_TITLE_MAX = 42;

// START_CONTRACT: formatPlatiTitle
//   PURPOSE: Show which plati listing the price came from, so a DLC or bundle mismatch is visible
//   INPUTS: { title: string - seller listing title }
//   OUTPUTS: { string - HTML-escaped, truncated title }
//   SIDE_EFFECTS: none
//   LINKS: M-PRICECARD, M-PLATI
// END_CONTRACT: formatPlatiTitle
function formatPlatiTitle(title: string): string {
    const trimmed = title.trim();
    const shortened = trimmed.length > PLATI_TITLE_MAX ? `${trimmed.slice(0, PLATI_TITLE_MAX).trimEnd()}…` : trimmed;

    return shortened
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export async function buildPriceCard(appId: string): Promise<PriceCardData | null> {
    const detailsRu = await getAppDetails(appId, "ru");
    const detailsKz = await getAppDetails(appId, "kz");

    // If both regions returned nothing, try global as last resort for the name
    let globalDetails: SteamAppDetails | null = null;
    if (!detailsRu && !detailsKz) {
        globalDetails = await getAppDetails(appId, "");
        if (!globalDetails) return null;
    } else if (!detailsRu) {
        // RU blocked but KZ exists — fetch global for English name (useful for plati.ru search)
        globalDetails = await getAppDetails(appId, "");
    }

    return buildCardFromDetails(appId, detailsRu, detailsKz, globalDetails);
}

async function buildCardFromDetails(
    appId: string,
    detailsRu: SteamAppDetails | null,
    detailsKz: SteamAppDetails | null,
    globalDetails: SteamAppDetails | null,
): Promise<PriceCardData> {
    const primary = detailsRu || detailsKz || globalDetails;
    const name = primary?.name || `App ${appId}`;

    // KZ conversion
    let priceKzInRub: number | null = null;
    if (detailsKz?.price_overview) {
        const rate = await getKztRate();
        priceKzInRub = convertKztToRub(detailsKz.price_overview.final, rate);
    }

    // Plati.ru — try primary name, then global (English) name as fallback
    let plati: PlatiResult | null = null;
    try {
        plati = await getPlatiCheapest(name);
        if (!plati && globalDetails?.name && globalDetails.name !== name) {
            console.log(`[M-PRICECARD] Plati: retrying with English name "${globalDetails.name}"`);
            plati = await getPlatiCheapest(globalDetails.name);
        }
    } catch {
        // non-critical
    }

    return {
        appId,
        name,
        headerImage: primary?.header_image,
        // RU
        priceRuFormatted: detailsRu?.price_overview?.final_formatted ?? null,
        priceRuFinal: detailsRu?.price_overview?.final ?? null,
        discountPctRu: detailsRu?.price_overview?.discount_percent ?? 0,
        // KZ
        priceKzFormatted: detailsKz?.price_overview?.final_formatted ?? null,
        priceKzFinal: detailsKz?.price_overview?.final ?? null,
        priceKzInRub,
        // Plati
        platiName: plati?.name ?? null,
        platiPriceRub: plati?.priceRur ?? null,
        platiUrl: plati?.url ?? null,
        // Meta
        isFree: primary?.is_free ?? false,
        familySharing: resolveFamilySharing(detailsRu, detailsKz, globalDetails),
    };
}

export function formatPriceCardHtml(card: PriceCardData): string {
    let msg = `🎮 <b><a href="https://store.steampowered.com/app/${card.appId}">${card.name}</a></b>\n\n`;

    if (card.isFree) {
        msg += `💰 <b>Цена:</b> Бесплатно\n`;
    } else {
        // RU price
        if (card.priceRuFormatted) {
            msg += `💰 <b>RU:</b> ${card.priceRuFormatted}`;
            if (card.discountPctRu > 0) {
                msg += ` <b>(-${card.discountPctRu}%)</b>`;
            }
            msg += `\n`;
        } else {
            msg += `💰 <b>RU:</b> N/A (регион заблокирован)\n`;
        }

        // KZ price
        if (card.priceKzFormatted && card.priceKzInRub !== null) {
            msg += `💰 <b>KZ:</b> ${card.priceKzFormatted} (~${card.priceKzInRub} ₽)\n`;
        }

        // Plati.ru
        if (card.platiPriceRub !== null && card.platiUrl) {
            msg += `🛒 <b>Plati.ru:</b> <a href="${card.platiUrl}">от ${card.platiPriceRub} ₽</a>`;
            if (card.platiName) msg += ` · <i>${formatPlatiTitle(card.platiName)}</i>`;
            msg += `\n`;
        }
    }

    msg += `👨‍👩‍👦 <b>Семейная библиотека:</b> ${FAMILY_SHARING_LABELS[card.familySharing]}\n`;

    return msg;
}

export function formatWatchlistAlertHtml(
    card: PriceCardData,
    historicalMinRu: number | null,
    historicalMinKzRub: number | null,
): string {
    let msg = `🔔 <b>Скидка на отслеживаемую игру!</b>\n\n`;
    msg += formatPriceCardHtml(card);

    // Historical minimums
    if (historicalMinRu !== null || historicalMinKzRub !== null) {
        msg += `\n📉 <b>Исторический минимум:</b>\n`;
        if (historicalMinRu !== null) {
            const ruRub = Math.round(historicalMinRu / 100);
            msg += `   RU: ${ruRub} ₽\n`;
        }
        if (historicalMinKzRub !== null) {
            msg += `   KZ: ~${historicalMinKzRub} ₽\n`;
        }
    }

    return msg;
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.1.0 - Price cards report family library support, resolved from the first region that returned categories]
//   LAST_CHANGE_2: [v2.2.0 - Show the plati listing title next to the price so a wrong lot is visible at a glance]
// END_CHANGE_SUMMARY
