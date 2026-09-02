// FILE: src/lib/steam.ts
// VERSION: 1.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Fetches owned games, app details, compatibility, family sharing support, free-promotion candidates, and achievements from Steam API with SteamSpy fallback
//   SCOPE: Provides strongly typed wrappers for Steam REST HTTP endpoints, Steam Store search, and SteamSpy fallback — every call routed through the Steam HTTP gateway (M-STEAMHTTP)
//   DEPENDS: M-STEAMHTTP
//   LINKS: M-STEAM
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   getOwnedGames — Fetch list of owned games for a user
//   getAppDetails — Fetch details and pricing for a specific game, cached for APPDETAILS_CACHE_TTL_MS via the Steam HTTP gateway
//   getAppNameFallback — SteamSpy fallback to get game name for delisted apps
//   detectFamilySharing — Resolve Steam Family Sharing support from app categories
//   getProtonTier — Fetch ProtonDB compatibility tier for a game
//   searchDiscountedFreeGames — Fetch current Steam search candidates with 100% discount
//   getCompatibilityText — Fetch combined official Steam Deck status and ProtonDB tier
//   getRecentlyPlayedGames - Fetch recently played games for achievement candidate detection
//   getPlayerAchievements - Fetch one player's achievement progress for a Steam app
//   getAchievementSchema - Fetch achievement metadata for a Steam app
//   getGlobalAchievementPercentages - Fetch global achievement rarity percentages for a Steam app
// END_MODULE_MAP

import { steamFetchJson, steamFetchText } from "./steamHttp";

export interface SteamGame {
    appid: number;
    playtime_forever?: number;
    playtime_2weeks?: number;
}

export interface SteamAppDetails {
    type?: string;
    name: string;
    is_free?: boolean;
    header_image?: string;
    short_description?: string;
    price_overview?: {
        currency?: string;
        initial?: number;
        initial_formatted?: string;
        final_formatted: string;
        final: number;
        discount_percent: number;
    };
    package_groups?: {
        name: string;
        title: string;
        subs?: {
            packageid: number;
            percent_savings_text?: string;
            option_text?: string;
            option_description?: string;
            price_in_cents_with_discount?: number;
        }[];
    }[];
    categories?: { id: number; description: string }[];
    metacritic?: { score: number; url: string };
}

// Steam store category 62 marks family-library eligibility and is region-independent
// (verified identical for cc=kz and cc=us); descriptions are the localized fallback.
const FAMILY_SHARING_CATEGORY_ID = 62;
const FAMILY_SHARING_DESCRIPTIONS = ["family sharing", "семейный доступ"];

export type FamilySharingSupport = "supported" | "unsupported" | "unknown";

// START_CONTRACT: detectFamilySharing
//   PURPOSE: Resolve whether a Steam app can be shared through the Steam family library
//   INPUTS: { details: SteamAppDetails | null | undefined — app details from any region }
//   OUTPUTS: { FamilySharingSupport — "supported" | "unsupported" | "unknown" }
//   SIDE_EFFECTS: none
//   LINKS: M-STEAM, M-PRICECARD, M-CORE
// END_CONTRACT: detectFamilySharing
export function detectFamilySharing(details: SteamAppDetails | null | undefined): FamilySharingSupport {
    // START_BLOCK_DETECT_FAMILY_SHARING
    const categories = details?.categories;

    // No categories at all means the region gave us nothing to judge by — not a negative answer.
    if (!categories || categories.length === 0) return "unknown";

    const supported = categories.some(category =>
        category.id === FAMILY_SHARING_CATEGORY_ID
        || FAMILY_SHARING_DESCRIPTIONS.some(marker => category.description.toLowerCase().includes(marker))
    );

    return supported ? "supported" : "unsupported";
    // END_BLOCK_DETECT_FAMILY_SHARING
}

interface SteamStoreSearchItem {
    id: number;
    name?: string;
}

export interface SteamDiscountSearchCandidate {
    appId: string;
    name: string;
}

export interface SteamReviewSummary {
    description: string;
    positivePercent: number;
    totalReviews: number;
    totalPositive: number;
    totalNegative: number;
    text: string;
}

export interface SteamPlayerAchievement {
    apiname: string;
    achieved: number | boolean;
    unlocktime?: number;
    name?: string;
    description?: string;
}

export interface SteamPlayerAchievements {
    gameName?: string;
    achievements: SteamPlayerAchievement[];
}

export interface SteamAchievementSchemaItem {
    name: string;
    displayName?: string;
    description?: string;
    hidden?: number;
    icon?: string;
    icongray?: string;
}

export interface SteamAchievementSchema {
    gameName?: string;
    achievements: SteamAchievementSchemaItem[];
}

export interface SteamGlobalAchievementPercentage {
    name: string;
    percent: number;
}

// START_CONTRACT: getOwnedGames
//   PURPOSE: Fetch list of owned games for a user
//   INPUTS: { steamId: string - The Steam ID 64, apiKey: string - Steam Web API Key }
//   OUTPUTS: { Promise<SteamGame[]> }
//   SIDE_EFFECTS: HTTP GET to api.steampowered.com
//   LINKS: M-STEAM
// END_CONTRACT: getOwnedGames
export async function getOwnedGames(steamId: string, apiKey: string): Promise<SteamGame[]> {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&include_played_free_games=1&format=json`;
    const data = await steamFetchJson<{ response?: { games?: SteamGame[] } }>(url);
    // pollAllUsers' per-user error handling (A5 escalation) is built on this throw: a user whose
    // profile stopped answering must surface as an error, not as a silent empty library.
    if (!data) throw new Error(`Steam API error: owned games unavailable for ${steamId}`);
    return data.response?.games || [];
}

// START_CONTRACT: getRecentlyPlayedGames
//   PURPOSE: Fetch recently played games for achievement candidate detection
//   INPUTS: { steamId: string - The Steam ID 64, apiKey: string - Steam Web API Key, count?: number - max rows }
//   OUTPUTS: { Promise<SteamGame[]> }
//   SIDE_EFFECTS: HTTP GET to api.steampowered.com
//   LINKS: M-STEAM, M-ACHIEVEMENTS
// END_CONTRACT: getRecentlyPlayedGames
export async function getRecentlyPlayedGames(steamId: string, apiKey: string, count: number = 100): Promise<SteamGame[]> {
    const safeCount = Math.max(1, Math.min(Math.floor(count || 100), 100));
    const params = new URLSearchParams({
        key: apiKey,
        steamid: steamId,
        count: String(safeCount),
        format: "json",
    });
    const url = `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/?${params.toString()}`;

    const data = await steamFetchJson<{ response?: { games?: SteamGame[] } }>(url);
    if (!data) return [];
    return Array.isArray(data.response?.games) ? data.response.games : [];
}

// START_CONTRACT: getPlayerAchievements
//   PURPOSE: Fetch one player's achievement progress for a Steam app
//   INPUTS: { appId: string, steamId: string, apiKey: string, language?: string }
//   OUTPUTS: { Promise<SteamPlayerAchievements | null> - null when achievements are unavailable/private }
//   SIDE_EFFECTS: HTTP GET to api.steampowered.com
//   LINKS: M-STEAM, M-ACHIEVEMENTS
// END_CONTRACT: getPlayerAchievements
export async function getPlayerAchievements(
    appId: string,
    steamId: string,
    apiKey: string,
    language: string = "russian",
): Promise<SteamPlayerAchievements | null> {
    const params = new URLSearchParams({
        key: apiKey,
        steamid: steamId,
        appid: appId,
        l: language,
        format: "json",
    });
    const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?${params.toString()}`;

    // A private profile answers 403 with a body carrying Steam's own reason ("Profile is not
    // public"); this endpoint is polled for every user/app pair, so a 400 ("this app has no
    // achievements") is a normal, high-volume answer and must stay silent. The gateway can't
    // know either of those things about an arbitrary endpoint, so onHttpError — same pattern as
    // getAppDetails' cacheIf — hands it back to the one caller who does.
    const data = await steamFetchJson<{
        playerstats?: {
            gameName?: string;
            success?: boolean | number;
            achievements?: SteamPlayerAchievement[];
        };
    }>(url, {
        onHttpError: (status, bodyText) => {
            if (status !== 403) return;
            let reason = "access denied";
            if (bodyText) {
                try {
                    const body = JSON.parse(bodyText) as { playerstats?: { error?: string } };
                    reason = body.playerstats?.error || reason;
                } catch {
                    // Keep the generic reason when Steam returns a non-JSON body.
                }
            }
            console.warn(`[M-STEAM] GetPlayerAchievements HTTP 403 for app ${appId}: ${reason}`);
        },
    });
    if (!data) return null;

    if (data.playerstats?.success === false || data.playerstats?.success === 0) {
        console.warn(`[M-STEAM] GetPlayerAchievements unsuccessful for app ${appId}`);
        return null;
    }

    const achievements = data.playerstats?.achievements;
    if (!Array.isArray(achievements) || achievements.length === 0) {
        return null;
    }

    return {
        gameName: data.playerstats?.gameName,
        achievements,
    };
}

// START_CONTRACT: getAchievementSchema
//   PURPOSE: Fetch achievement metadata for a Steam app
//   INPUTS: { appId: string, apiKey: string, language?: string }
//   OUTPUTS: { Promise<SteamAchievementSchema | null> - null when schema is unavailable }
//   SIDE_EFFECTS: HTTP GET to api.steampowered.com
//   LINKS: M-STEAM, M-ACHIEVEMENTS
// END_CONTRACT: getAchievementSchema
export async function getAchievementSchema(
    appId: string,
    apiKey: string,
    language: string = "russian",
): Promise<SteamAchievementSchema | null> {
    const params = new URLSearchParams({
        key: apiKey,
        appid: appId,
        l: language,
        format: "json",
    });
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?${params.toString()}`;

    const data = await steamFetchJson<{
        game?: {
            gameName?: string;
            availableGameStats?: { achievements?: SteamAchievementSchemaItem[] };
        };
    }>(url);
    if (!data) return null;

    const achievements = data.game?.availableGameStats?.achievements;
    if (!Array.isArray(achievements) || achievements.length === 0) {
        return null;
    }

    return {
        gameName: data.game?.gameName,
        achievements,
    };
}

// START_CONTRACT: getGlobalAchievementPercentages
//   PURPOSE: Fetch global achievement rarity percentages for a Steam app
//   INPUTS: { appId: string }
//   OUTPUTS: { Promise<SteamGlobalAchievementPercentage[]> }
//   SIDE_EFFECTS: HTTP GET to api.steampowered.com
//   LINKS: M-STEAM, M-ACHIEVEMENTS
// END_CONTRACT: getGlobalAchievementPercentages
export async function getGlobalAchievementPercentages(appId: string): Promise<SteamGlobalAchievementPercentage[]> {
    const params = new URLSearchParams({ gameid: appId, format: "json" });
    const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?${params.toString()}`;

    const data = await steamFetchJson<{
        achievementpercentages?: { achievements?: SteamGlobalAchievementPercentage[] };
    }>(url);
    if (!data) return [];
    return Array.isArray(data.achievementpercentages?.achievements)
        ? data.achievementpercentages.achievements
        : [];
}

// getAppDetails is the hottest Steam call in the service — the library poll, the watchlist
// check, the free-promotions sweep and the bot's /price command all reach it, often for the
// same appId within one cycle. It is the one call routed through the gateway with a cache.
export const APPDETAILS_CACHE_TTL_MS = 600_000; // ten minutes: prices do not move faster than that

type AppDetailsResponse = Record<string, { success?: boolean; data?: SteamAppDetails }>;

// A response is only "usable" — and therefore only ever cached — when Steam's own entry for
// this appId reports success with data attached. Steam answers an unavailable app with HTTP 200
// and `{"<id>":{"success":false}}`: that is a transient blip, not a verdict, and caching it would
// turn one bad response into a single "unavailable" answer replayed to every caller (the library
// poll, the watchlist check, the free-promotions sweep, the bot's /price command) for the full
// ten-minute TTL — the exact confusion this cache exists to remove, just inverted. This same
// predicate gates both the cache write (via cacheIf below) and the null-return check, so the two
// can never drift apart.
function isUsableAppDetails(data: AppDetailsResponse, appId: string): boolean {
    const appData = data[appId];
    return Boolean(appData?.success && appData.data);
}

// START_CONTRACT: getAppDetails
//   PURPOSE: Fetch details and pricing for a specific game, cached for APPDETAILS_CACHE_TTL_MS —
//            but only when the response is usable (see isUsableAppDetails); a negative body at
//            HTTP 200 is deliberately never cached, so one bad response cannot be replayed as a
//            shared "unavailable" verdict to every caller for the full TTL
//   INPUTS: { appId: string - The Steam Application ID, cc: string - target currency }
//   OUTPUTS: { Promise<SteamAppDetails | null> - null if app is delisted/unavailable }
//   SIDE_EFFECTS: HTTP GET to store.steampowered.com via the Steam HTTP gateway (throttled, retried, cached)
//   LINKS: M-STEAM, M-STEAMHTTP
// END_CONTRACT: getAppDetails
export async function getAppDetails(appId: string, cc: string = 'ru'): Promise<SteamAppDetails | null> {
    // Single request for the exact region requested — no internal fallback.
    // Callers handle region fallback explicitly (e.g. pollAllUsers tries RU, then global).
    const url = cc
        ? `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=russian`
        : `https://store.steampowered.com/api/appdetails?appids=${appId}&l=russian`;

    const data = await steamFetchJson<AppDetailsResponse>(url, {
        cacheTtlMs: APPDETAILS_CACHE_TTL_MS,
        cacheIf: (value) => isUsableAppDetails(value, appId),
    });
    if (!data) return null;

    if (!isUsableAppDetails(data, appId)) {
        console.warn(`[M-STEAM] App ${appId} unavailable for cc=${cc || "global"}`);
        return null;
    }

    return data[appId].data as SteamAppDetails;
}

// START_CONTRACT: getAppNameFallback
//   PURPOSE: Fetch game name from SteamSpy as fallback for delisted/removed apps
//   INPUTS: { appId: string - The Steam Application ID }
//   OUTPUTS: { Promise<string | null> - Game name or null if SteamSpy also has no data }
//   SIDE_EFFECTS: HTTP GET to steamspy.com
//   LINKS: M-STEAM
// END_CONTRACT: getAppNameFallback
export async function getAppNameFallback(appId: string): Promise<string | null> {
    // START_BLOCK_STEAMSPY_FETCH
    const url = `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;
    const data = await steamFetchJson<{ name?: string }>(url);
    if (!data) return null;

    // SteamSpy returns {"name": "..."} even for some delisted games
    // but may return empty name or appid as name for truly unknown apps
    if (data.name && data.name !== String(appId) && data.name.trim() !== '') {
        console.log(`[M-STEAM] SteamSpy fallback found name for app ${appId}: ${data.name}`);
        return data.name;
    }

    console.warn(`[M-STEAM] SteamSpy has no name for app ${appId}`);
    return null;
    // END_BLOCK_STEAMSPY_FETCH
}

// START_CONTRACT: getProtonTier
//   PURPOSE: Fetch ProtonDB compatibility tier for a game
//   INPUTS: { appId: string }
//   OUTPUTS: { Promise<string | null> }
//   SIDE_EFFECTS: HTTP GET to protondb.com
//   LINKS: M-STEAM
// END_CONTRACT: getProtonTier
export async function getProtonTier(appId: string): Promise<string | null> {
    const url = `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`;
    const data = await steamFetchJson<{ tier?: string; bestReportedTier?: string; trendingTier?: string }>(url);
    if (!data) return null;
    return data.tier || data.bestReportedTier || data.trendingTier || null;
}

// START_CONTRACT: getCompatibilityText
//   PURPOSE: Fetch combined official Steam Deck status and ProtonDB tier for display
//   INPUTS: { appId: string }
//   OUTPUTS: { Promise<string | null> }
//   SIDE_EFFECTS: HTTP GET to store.steampowered.com and protondb.com
//   LINKS: M-STEAM
// END_CONTRACT: getCompatibilityText
export async function getCompatibilityText(appId: string): Promise<string | null> {
    const deckStatus = await getSteamDeckStatus(appId);
    const protonTier = await getProtonTier(appId);
    const protonText = protonTier ? `ProtonDB ${capitalizeCompatibility(protonTier)}` : null;

    if (deckStatus && protonText) return `${deckStatus} / ${protonText}`;
    return deckStatus || protonText;
}

// START_CONTRACT: getReviewSummary
//   PURPOSE: Fetch and format Steam user review score for display in promotion alerts
//   INPUTS: { appId: string }
//   OUTPUTS: { Promise<string | null> - formatted summary or null when unavailable/no reviews }
//   SIDE_EFFECTS: HTTP GET to store.steampowered.com/appreviews
//   LINKS: M-STEAM, M-FREEPROMOS
// END_CONTRACT: getReviewSummary
export async function getReviewSummary(appId: string): Promise<string | null> {
    const url = `https://store.steampowered.com/appreviews/${encodeURIComponent(appId)}?json=1&language=all&purchase_type=all&num_per_page=0`;

    const data = await steamFetchJson<{
        success?: number;
        query_summary?: {
            review_score_desc?: string;
            total_positive?: number;
            total_negative?: number;
            total_reviews?: number;
        };
    }>(url);
    if (!data) return null;
    if (data.success === 0) return null;

    const summary = data.query_summary;
    const rawTotalReviews = Number(summary?.total_reviews || 0);
    const totalPositive = Number(summary?.total_positive || 0);
    const totalNegative = Number(summary?.total_negative || 0);
    const totalReviews = rawTotalReviews > 0 ? rawTotalReviews : totalPositive + totalNegative;
    if (totalReviews <= 0) return null;

    const positivePercent = Math.round((totalPositive / totalReviews) * 100);
    const description = translateReviewScoreDescription(summary?.review_score_desc || "");
    const reviewCount = formatReviewCount(totalReviews);
    return `${description} — ${positivePercent}% из ${reviewCount}`;
}

function translateReviewScoreDescription(value: string): string {
    const map: Record<string, string> = {
        "Overwhelmingly Positive": "Крайне положительные",
        "Very Positive": "Очень положительные",
        "Mostly Positive": "В основном положительные",
        "Positive": "Положительные",
        "Mixed": "Смешанные",
        "Mostly Negative": "В основном отрицательные",
        "Negative": "Отрицательные",
        "Very Negative": "Очень отрицательные",
        "Overwhelmingly Negative": "Крайне отрицательные",
    };
    return map[value] || value || "Отзывы неизвестны";
}

function formatReviewCount(value: number): string {
    return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " ");
}

async function getSteamDeckStatus(appId: string): Promise<string | null> {
    const url = `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appId}`;
    const data = await steamFetchJson<{ success?: number; results?: { resolved_category?: number } }>(url);
    if (!data || data.success !== 1) return null;
    return mapDeckCategory(data.results?.resolved_category);
}

function mapDeckCategory(category: number | undefined): string | null {
    switch (category) {
        case 1:
            return "Unsupported";
        case 2:
            return "Playable";
        case 3:
            return "Verified";
        default:
            return null;
    }
}

function capitalizeCompatibility(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

// START_CONTRACT: searchSteamGames
//   PURPOSE: Search Steam store for games by name (or return directly if appId given)
//   INPUTS: { query: string, limit: number }
//   OUTPUTS: { Promise<{appId: string, name: string}[]> }
//   SIDE_EFFECTS: HTTP GET to store.steampowered.com
//   LINKS: M-STEAM
// END_CONTRACT: searchSteamGames
export async function searchSteamGames(query: string, limit: number = 5): Promise<{ appId: string; name: string }[]> {
    if (!query || query.trim().length === 0) return [];

    // If query is a numeric appId, return it directly
    if (/^\d+$/.test(query.trim())) {
        return [{ appId: query.trim(), name: "" }];
    }

    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query.trim())}&l=russian&cc=ru`;
    const text = await steamFetchText(url);
    if (text === null) return [];

    try {
        const data = JSON.parse(text) as { items?: SteamStoreSearchItem[] };
        const items = data.items || [];

        return items.slice(0, limit).map((item) => ({
            appId: String(item.id),
            name: item.name || "",
        }));
    } catch (err) {
        console.warn(`[M-STEAM] Store search parse error for query "${query}":`, err);
        return [];
    }
}

// START_CONTRACT: searchDiscountedFreeGames
//   PURPOSE: Find Steam Store search candidates currently shown as 100% discounted games
//   INPUTS: { cc: string - region code, count: number - max search rows }
//   OUTPUTS: { Promise<SteamDiscountSearchCandidate[]> }
//   SIDE_EFFECTS: HTTP GET to store.steampowered.com
//   LINKS: M-STEAM, M-FREEPROMOS
// END_CONTRACT: searchDiscountedFreeGames
export function buildDiscountedFreeSearchUrl(cc: string, start: number, count: number): string {
    const params = new URLSearchParams({
        query: "",
        start: String(start),
        count: String(count),
        dynamic_data: "",
        sort_by: "Price_ASC",
        specials: "1",
        discount: "100",
        category1: "998",
        cc,
        l: "russian",
        infinite: "1",
    });
    return `https://store.steampowered.com/search/results/?${params.toString()}`;
}

export async function searchDiscountedFreeGames(cc: string, count: number = 100): Promise<SteamDiscountSearchCandidate[]> {
    const safeCount = Math.max(1, Math.min(Math.floor(count || 100), 500));
    const pageSize = 100;
    const candidates = new Map<string, SteamDiscountSearchCandidate>();

    for (let start = 0; start < safeCount; start += pageSize) {
        const currentCount = Math.min(pageSize, safeCount - start);
        const url = buildDiscountedFreeSearchUrl(cc, start, currentCount);

        const text = await steamFetchText(url);
        if (text === null) break;

        try {
            const data = JSON.parse(text) as { results_html?: string };
            const found = parseDiscountedFreeSearchHtml(data.results_html || "");
            for (const item of found) {
                candidates.set(item.appId, item);
            }
        } catch (err) {
            console.warn(`[M-STEAM] Discount search parse error for cc=${cc} start=${start}:`, err);
            break;
        }
    }

    return Array.from(candidates.values());
}

function parseDiscountedFreeSearchHtml(html: string): SteamDiscountSearchCandidate[] {
    const candidates = new Map<string, SteamDiscountSearchCandidate>();
    const rowRegex = /<a\b(?=[^>]*data-ds-appid="(\d+)")[^>]*>[\s\S]*?<\/a>/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
        const row = rowMatch[0];
        const appId = rowMatch[1];
        if (!row.includes("data-ds-itemkey=\"App_")) continue;
        const hasHundredPercentBadge = /<div class="discount_pct">\s*-100%\s*<\/div>/.test(row);
        const hasHundredPercentData = /\bdata-discount="100"/.test(row);
        if (!hasHundredPercentBadge && !hasHundredPercentData) continue;

        const titleMatch = row.match(/<span class="title">([^<]+)<\/span>/);
        const name = titleMatch ? decodeSteamHtml(titleMatch[1]) : `App ${appId}`;
        candidates.set(appId, { appId, name });
    }

    return Array.from(candidates.values());
}

function decodeSteamHtml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.2.0 — Added official Steam Deck compatibility fallback and combined display text]
//   LAST_CHANGE_2: [v2.3.0 - Added recently played games API for achievement candidate detection]
//   LAST_CHANGE_3: [v2.4.0 - Log Steam achievement 403 reasons for private-profile diagnostics]
//   LAST_CHANGE_4: [v2.5.0 - Search paged Steam free specials and keep only real 100-percent discount rows for promotion validation]
//   LAST_CHANGE_5: [v2.6.0 - Added detectFamilySharing as the single source of truth for Steam family library support]
//   LAST_CHANGE_6: [v2.7.0 - Routed getAppDetails through the steamHttp gateway with a ten-minute cache]
//   LAST_CHANGE_7: [v2.8.0 - Fixed getAppDetails to never cache a negative (success:false) body via steamFetchJson's cacheIf]
//   LAST_CHANGE_8: [v2.9.0 - Every HTTP call goes through the throttled gateway; appdetails cached for 10 minutes]
//   LAST_CHANGE_9: [v3.0.0 - Restored the GetPlayerAchievements 403 reason log and 400 silence via steamFetchJson's onHttpError]
// END_CHANGE_SUMMARY
