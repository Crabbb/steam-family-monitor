// FILE: src/lib/plati.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Searches plati.ru for Steam game key prices — returns cheapest among top-5 sellers
//   SCOPE: Single function getPlatiCheapest() with rate-limiting, Steam-only and add-on/DLC filtering
//   DEPENDS: none
//   LINKS: M-PLATI
// END_MODULE_CONTRACT

export interface PlatiResult {
    name: string;
    priceRur: number; // whole rubles
    url: string;
    numSold: number;
}

interface PlatiApiItem {
    name?: string;
    description?: string;
    name_eng?: string;
    price_rur?: number;
    numsold?: number;
    url?: string;
    section_id?: number;
}

let lastCallTime = 0;

// Exclude accounts, rentals, PS/Xbox listings
const EXCLUDE_NAME_RE = /аккаунт|account|аренда|rental|оффлайн|offline|ps[45]|playstation|xbox|общий|shared|nintendo|switch|активация|п[23]|origin|epic games|uplay|gog/i;

// Add-on markers that can never describe a base game listing
const ADDON_HARD_RE = /улучшение до|апгрейд|upgrade|season pass|сезонн\w*\s+пропуск/i;

// "DLC" and "дополнение" are ambiguous: an add-on says it IS one, a bundle says it INCLUDES them
const ADDON_SOFT_RE = /dlc|дополнени\w*|expansion/gi;
const ADDON_INCLUDED_RE = /(вс[еёя]|all|\+|включ\w*|with|без|не\s+вход\w*|not\s+included)[^\p{L}]*$/iu;

// Sellers must warn in the description when a listing needs the base game - the strongest signal
const DESCRIPTION_ADDON_RE = /это\s+dlc|данное\s+dlc|это\s+дополнение|наличие\s+(основн|стандартн|базов|steam-верси)/i;
const STEAM_RE = /steam/i;

// Known account/rental section IDs on plati.ru (they differ per game but these appear consistently)
const ACCOUNT_SECTIONS = new Set([22764, 22229, 22380, 22611, 24103, 25540]);

// START_CONTRACT: marksItselfAsAddon
//   PURPOSE: Tell a DLC/upgrade listing from a full-game listing that merely bundles DLC
//   INPUTS: { title: string - one of the seller titles }
//   OUTPUTS: { boolean - true when the listing IS add-on content }
//   SIDE_EFFECTS: none
//   LINKS: M-PLATI
// END_CONTRACT: marksItselfAsAddon
function marksItselfAsAddon(title: string): boolean {
    // START_BLOCK_DETECT_ADDON_TITLE
    if (ADDON_HARD_RE.test(title)) return true;

    for (const match of title.matchAll(ADDON_SOFT_RE)) {
        const before = title.slice(Math.max(0, (match.index ?? 0) - 25), match.index);
        if (!ADDON_INCLUDED_RE.test(before)) return true;
    }

    return false;
    // END_BLOCK_DETECT_ADDON_TITLE
}

function isSteamKey(item: PlatiApiItem): boolean {
    // Exclude known account sections
    if (item.section_id !== undefined && ACCOUNT_SECTIONS.has(item.section_id)) return false;

    // Both titles matter: a Russian title can look clean while the English one says "Upgrade ... dlc"
    const titles = [item.name || "", item.name_eng || ""].filter(title => title.length > 0);
    if (titles.length === 0) return false;
    if (titles.some(title => EXCLUDE_NAME_RE.test(title))) return false;
    if (!titles.some(title => STEAM_RE.test(title))) return false;
    if (titles.some(marksItselfAsAddon)) return false;
    if (item.description && DESCRIPTION_ADDON_RE.test(item.description)) return false;

    return true;
}

export async function getPlatiCheapest(gameName: string): Promise<PlatiResult | null> {
    if (!gameName || gameName.length < 3) {
        return null;
    }

    // Rate-limit: min 1s between calls
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - lastCallTime));
    if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
    }
    lastCallTime = Date.now();

    try {
        const url = `https://plati.io/api/search.ashx?query=${encodeURIComponent(gameName)}&response=json`;
        const res = await fetch(url);

        if (!res.ok) {
            console.warn(`[M-PLATI] Plati.ru API HTTP ${res.status}`);
            return null;
        }

        const data = await res.json() as { items?: PlatiApiItem[] } | PlatiApiItem[];

        // API returns { items: [...] } object, not a flat array
        const items = Array.isArray(data) ? data : data.items;
        if (!items || items.length === 0) {
            console.log(`[M-PLATI] No results for "${gameName}"`);
            return null;
        }

        // Filter: must have price, must be a Steam key (not account/rental/PS/Xbox)
        const steamKeys = items.filter((item) => (item.price_rur || 0) > 0 && isSteamKey(item));
        if (steamKeys.length === 0) {
            console.log(`[M-PLATI] ${items.length} results for "${gameName}" but no Steam keys after filtering`);
            return null;
        }

        // Sort by numsold DESC, take top 5
        steamKeys.sort((a, b) => (b.numsold || 0) - (a.numsold || 0));
        const top5 = steamKeys.slice(0, 5);

        // Find cheapest among top 5
        let cheapest = top5[0];
        for (const item of top5) {
            if ((item.price_rur || 0) < (cheapest.price_rur || 0)) {
                cheapest = item;
            }
        }

        const result: PlatiResult = {
            name: cheapest.name || cheapest.name_eng || gameName,
            priceRur: Math.round(cheapest.price_rur || 0),
            url: cheapest.url?.startsWith("http") ? cheapest.url : `https://plati.market${cheapest.url || ""}`,
            numSold: cheapest.numsold || 0,
        };

        console.log(`[M-PLATI] Found for "${gameName}": ${result.priceRur} ₽ (sold: ${result.numSold})`);
        return result;
    } catch (err) {
        console.warn("[M-PLATI] Failed to fetch from plati.ru:", err);
        return null;
    }
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.1.0 - Reject DLC/upgrade listings: check both seller titles plus the description,
//                 while keeping bundles that only include DLC (reported case: Spider-Man 2 Deluxe upgrade
//                 shown as the base game price)]
// END_CHANGE_SUMMARY
