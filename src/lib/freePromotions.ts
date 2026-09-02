// FILE: src/lib/freePromotions.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Discovers Steam free-to-keep promotions, filters them, formats Telegram alerts, and deduplicates sends
//   SCOPE: Steam Store Search discovery, appdetails validation, ownership filtering, Telegram notification dispatch
//   DEPENDS: M-DB, M-STEAM, M-TG
//   LINKS: M-FREEPROMOS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   isFreeToKeepPromotion — Validate appdetails package data for a real 100% free-to-keep promotion
//   discoverFreePromotions — Collect and validate promotion candidates from configured regions
//   formatFreePromotionMessage — Format a compact Telegram HTML promotion announcement
//   checkFreePromotions — Run the scheduled discovery, dedupe, ownership filter, and Telegram send cycle
// END_MODULE_MAP

import { prisma } from "./db";
import {
    getAppDetails,
    getCompatibilityText,
    getReviewSummary,
    searchDiscountedFreeGames,
    SteamAppDetails,
} from "./steam";
import { sendTelegramMessage } from "./telegram";

export type FreePromoRegion = "ru" | "kz";

export interface PromotionDetection {
    isPromotion: boolean;
    packageIds: string[];
    originalFormatted?: string;
    finalFormatted?: string;
}

export interface FreePromotionRegionalInfo {
    packageIds: string[];
    originalFormatted: string;
    finalFormatted: string;
}

export interface FreePromotionData {
    appId: string;
    name: string;
    headerImage?: string;
    shortDescription?: string;
    promotionKey: string;
    regions: FreePromoRegion[];
    regional: Partial<Record<FreePromoRegion, FreePromotionRegionalInfo>>;
    compatibilityText?: string | null;
    reviewSummaryText?: string | null;
}

export interface DiscoverFreePromotionsOptions {
    regions: FreePromoRegion[];
    searchCount: number;
}

const MIN_FREE_PROMO_SEARCH_ROWS = 200;

const FREE_WEEKEND_PATTERN = /free\s*weekend|play\s*for\s*free|бесплатн\S*\s+выходн|играть\s+бесплатно/i;

// START_CONTRACT: isFreeToKeepPromotion
//   PURPOSE: Decide whether regional Steam appdetails represent a real free-to-keep 100% promotion
//   INPUTS: { details: SteamAppDetails | null }
//   OUTPUTS: { PromotionDetection }
//   SIDE_EFFECTS: none
//   LINKS: M-FREEPROMOS, M-STEAM
// END_CONTRACT: isFreeToKeepPromotion
export function isFreeToKeepPromotion(details: SteamAppDetails | null | undefined): PromotionDetection {
    if (!details || details.type !== "game") {
        return { isPromotion: false, packageIds: [] };
    }

    const packageIds = new Set<string>();

    for (const group of details.package_groups || []) {
        for (const sub of group.subs || []) {
            const text = `${group.title || ""} ${sub.percent_savings_text || ""} ${sub.option_text || ""} ${sub.option_description || ""}`;
            const hasFreeWeekendText = FREE_WEEKEND_PATTERN.test(text);
            const hasHundredPercent = (sub.percent_savings_text || "").includes("100")
                || details.price_overview?.discount_percent === 100;
            const hasZeroPrice = sub.price_in_cents_with_discount === 0;

            if (hasHundredPercent && hasZeroPrice && !hasFreeWeekendText) {
                packageIds.add(String(sub.packageid));
            }
        }
    }

    if (packageIds.size === 0) {
        return { isPromotion: false, packageIds: [] };
    }

    return {
        isPromotion: true,
        packageIds: Array.from(packageIds).sort(),
        originalFormatted: details.price_overview?.initial_formatted || details.price_overview?.final_formatted || "Цена неизвестна",
        finalFormatted: details.price_overview?.final_formatted || "Бесплатно",
    };
}

// START_CONTRACT: discoverFreePromotions
//   PURPOSE: Discover unique Steam apps that are free-to-keep in at least one configured region
//   INPUTS: { options: DiscoverFreePromotionsOptions }
//   OUTPUTS: { Promise<FreePromotionData[]> }
//   SIDE_EFFECTS: HTTP GET through M-STEAM
//   LINKS: M-FREEPROMOS, M-STEAM
// END_CONTRACT: discoverFreePromotions
export async function discoverFreePromotions(options: DiscoverFreePromotionsOptions): Promise<FreePromotionData[]> {
    const candidates = new Map<string, { appId: string; name: string }>();
    const searchCount = Math.max(MIN_FREE_PROMO_SEARCH_ROWS, options.searchCount || 0);

    for (const region of options.regions) {
        const found = await searchDiscountedFreeGames(region, searchCount);
        for (const item of found) {
            candidates.set(item.appId, item);
        }
    }

    const promotions: FreePromotionData[] = [];

    for (const candidate of candidates.values()) {
        const regional: Partial<Record<FreePromoRegion, FreePromotionRegionalInfo>> = {};
        const activeRegions: FreePromoRegion[] = [];
        const promotionPackageIds = new Set<string>();
        let primaryDetails: SteamAppDetails | null = null;

        for (const region of options.regions) {
            const details = await getAppDetails(candidate.appId, region);
            const detection = isFreeToKeepPromotion(details);
            if (!details || !detection.isPromotion) continue;

            primaryDetails ||= details;
            activeRegions.push(region);
            detection.packageIds.forEach(packageId => promotionPackageIds.add(packageId));
            regional[region] = {
                packageIds: detection.packageIds,
                originalFormatted: detection.originalFormatted || "Цена неизвестна",
                finalFormatted: detection.finalFormatted || "Бесплатно",
            };
        }

        if (!primaryDetails || activeRegions.length === 0) continue;

        promotions.push({
            appId: candidate.appId,
            name: primaryDetails.name || candidate.name,
            headerImage: primaryDetails.header_image,
            shortDescription: primaryDetails.short_description,
            promotionKey: Array.from(promotionPackageIds).sort().join("+"),
            regions: activeRegions,
            regional,
        });
    }

    return promotions;
}

// START_CONTRACT: formatFreePromotionMessage
//   PURPOSE: Format a Telegram HTML message for a free-to-keep promotion
//   INPUTS: { promotion: FreePromotionData }
//   OUTPUTS: { string — Telegram HTML }
//   SIDE_EFFECTS: none
//   LINKS: M-FREEPROMOS, M-TG
// END_CONTRACT: formatFreePromotionMessage
export function formatFreePromotionMessage(promotion: FreePromotionData): string {
    const name = escapeHtml(promotion.name);
    const steamUrl = `https://store.steampowered.com/app/${promotion.appId}`;
    const steamDbUrl = `https://steamdb.info/app/${promotion.appId}/`;
    const protonUrl = `https://www.protondb.com/app/${promotion.appId}`;
    const compatibilityText = promotion.compatibilityText
        ? promotion.compatibilityText
        : "Неизвестно";

    let msg = `🎁 <b>Бесплатно навсегда: <a href="${steamUrl}">${name}</a></b>\n\n`;
    msg += `💸 <b>Скидка:</b> -100% (не бесплатные выходные)\n`;
    msg += `🌍 <b>Доступность:</b>\n`;

    for (const region of ["ru", "kz"] as FreePromoRegion[]) {
        const info = promotion.regional[region];
        if (!info) continue;
        msg += `${region === "ru" ? "🇷🇺" : "🇰🇿"} <b>${region.toUpperCase()}:</b> ${escapeHtml(info.originalFormatted)} → ${escapeHtml(info.finalFormatted)}\n`;
    }

    msg += `🐧 <b>Steam Deck / Linux:</b> <a href="${protonUrl}">${escapeHtml(compatibilityText)}</a>\n`;

    if (promotion.reviewSummaryText) {
        msg += `⭐ <b>Отзывы Steam:</b> ${escapeHtml(promotion.reviewSummaryText)}\n`;
    }

    if (promotion.shortDescription) {
        msg += `\n📝 <i>${escapeHtml(promotion.shortDescription)}</i>\n`;
    }

    msg += `\n🔗 <a href="${steamUrl}">Steam</a> | <a href="${steamDbUrl}">SteamDB</a> | <a href="${protonUrl}">ProtonDB</a>`;
    return msg;
}

// START_CONTRACT: checkFreePromotions
//   PURPOSE: Scheduled job entry point for discovering, filtering, sending, and recording free promotions
//   INPUTS: {}
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: Reads/writes SQLite via Prisma, sends Telegram messages
//   LINKS: M-FREEPROMOS, M-DB, M-TG
// END_CONTRACT: checkFreePromotions
export async function checkFreePromotions(): Promise<void> {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.telegramToken || !settings.telegramChatId || !settings.freePromosEnabled) {
        console.warn("[M-FREEPROMOS] Free promotions disabled or Telegram settings missing");
        return;
    }

    const regions = getConfiguredRegions(settings.freePromosRegionRu, settings.freePromosRegionKz);
    if (regions.length === 0) {
        console.warn("[M-FREEPROMOS] No regions enabled, skipping");
        return;
    }

    const promotions = await discoverFreePromotions({
        regions,
        searchCount: settings.freePromosSearchCount || 100,
    });

    for (const promotion of promotions) {
        const existing = await prisma.freePromotionNotification.findUnique({
            where: {
                appId_promotionKey: {
                    appId: promotion.appId,
                    promotionKey: promotion.promotionKey,
                },
            },
        });
        if (existing) continue;

        if (settings.freePromosSkipOwnedByAll && await isOwnedByAllUsers(promotion.appId)) {
            console.log(`[M-FREEPROMOS] Skipping ${promotion.appId}: owned by all monitored users`);
            continue;
        }

        promotion.compatibilityText = await getCompatibilityText(promotion.appId);
        promotion.reviewSummaryText = await getReviewSummary(promotion.appId);
        const html = formatFreePromotionMessage(promotion);
        const sent = await sendTelegramMessage(html, settings.telegramChatId, settings.telegramToken, promotion.headerImage);
        if (!sent) continue;

        await prisma.freePromotionNotification.create({
            data: {
                appId: promotion.appId,
                name: promotion.name,
                promotionKey: promotion.promotionKey,
                regions: promotion.regions.join(","),
            },
        });
    }
}

function getConfiguredRegions(ru: boolean, kz: boolean): FreePromoRegion[] {
    const regions: FreePromoRegion[] = [];
    if (ru) regions.push("ru");
    if (kz) regions.push("kz");
    return regions;
}

async function isOwnedByAllUsers(appId: string): Promise<boolean> {
    const usersCount = await prisma.user.count();
    if (usersCount === 0) return false;

    const owners = await prisma.game.findMany({
        where: { appId },
        select: { userId: true },
    });
    const ownerIds = new Set(owners.map(owner => owner.userId));
    return ownerIds.size >= usersCount;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 — Use official Steam Deck compatibility plus ProtonDB tier in promotion alerts]
//   LAST_CHANGE_2: [v1.2.0 - Scan at least two Steam free-special pages before appdetails validation]
// END_CHANGE_SUMMARY
