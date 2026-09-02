// FILE: src/lib/cbr.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Fetches and caches KZT-to-RUB exchange rate from CBR (Central Bank of Russia)
//   SCOPE: Provides getKztRate() with 3-tier fallback (memory -> DB -> hardcoded) and convertKztToRub()
//   DEPENDS: M-DB
//   LINKS: M-CBR
// END_MODULE_CONTRACT

import { prisma } from "./db";

export interface KztRate {
    kztValue: number;   // e.g. 16.1158 (rate for Nominal tenge)
    kztNominal: number; // e.g. 100
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const HARDCODED_FALLBACK: KztRate = { kztValue: 16.1158, kztNominal: 100 };

let cachedRate: (KztRate & { fetchedAt: number }) | null = null;

export async function getKztRate(): Promise<KztRate> {
    // Tier 1: in-memory cache
    if (cachedRate && (Date.now() - cachedRate.fetchedAt) < CACHE_TTL_MS) {
        return { kztValue: cachedRate.kztValue, kztNominal: cachedRate.kztNominal };
    }

    // Tier 2: fetch from CBR API
    try {
        const res = await fetch("https://www.cbr-xml-daily.ru/daily_json.js");
        if (res.ok) {
            const data = await res.json();
            const kzt = data?.Valute?.KZT;
            if (kzt && typeof kzt.Value === "number" && typeof kzt.Nominal === "number") {
                const rate: KztRate = { kztValue: kzt.Value, kztNominal: kzt.Nominal };
                cachedRate = { ...rate, fetchedAt: Date.now() };

                // Persist to DB
                try {
                    await prisma.exchangeRateCache.upsert({
                        where: { id: 1 },
                        update: { kztValue: rate.kztValue, kztNominal: rate.kztNominal, fetchedAt: new Date() },
                        create: { kztValue: rate.kztValue, kztNominal: rate.kztNominal },
                    });
                } catch (dbErr) {
                    console.warn("[M-CBR] Failed to persist rate to DB:", dbErr);
                }

                console.log(`[M-CBR] Fetched CBR rate: ${rate.kztValue} per ${rate.kztNominal} KZT`);
                return rate;
            }
        }
        console.warn(`[M-CBR] CBR API returned unexpected response`);
    } catch (err) {
        console.warn("[M-CBR] Failed to fetch CBR rate:", err);
    }

    // Tier 3: DB cache fallback
    try {
        const dbRate = await prisma.exchangeRateCache.findUnique({ where: { id: 1 } });
        if (dbRate) {
            cachedRate = { kztValue: dbRate.kztValue, kztNominal: dbRate.kztNominal, fetchedAt: Date.now() };
            console.log(`[M-CBR] Using DB-cached rate: ${dbRate.kztValue} per ${dbRate.kztNominal} KZT`);
            return { kztValue: dbRate.kztValue, kztNominal: dbRate.kztNominal };
        }
    } catch (dbErr) {
        console.warn("[M-CBR] Failed to read rate from DB:", dbErr);
    }

    // Tier 4: hardcoded fallback
    console.warn(`[M-CBR] Using hardcoded fallback rate: ${HARDCODED_FALLBACK.kztValue} per ${HARDCODED_FALLBACK.kztNominal} KZT`);
    return HARDCODED_FALLBACK;
}

/**
 * Convert Steam KZ price (in kopecks/tiyn, i.e. price_overview.final) to rubles.
 * Steam final is in smallest currency unit (tiyn for KZT), so /100 gives tenge.
 * Then multiply by (kztValue / kztNominal) to get rubles.
 */
export function convertKztToRub(priceKztFinal: number, rate: KztRate): number {
    return Math.round((priceKztFinal / 100) * (rate.kztValue / rate.kztNominal));
}
