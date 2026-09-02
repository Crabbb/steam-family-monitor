// FILE: src/lib/steamHttp.ts
// VERSION: 1.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Single throttled, retrying, caching entry point for every Steam HTTP call
//   SCOPE: Rate limiting per process, retry on 429 and 5xx, in-memory TTL cache of JSON responses
//   DEPENDS: none
//   LINKS: M-STEAMHTTP
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   steamFetchJson — Fetch one Steam JSON endpoint through the throttle, retry and cache
//   steamFetchText — Fetch one Steam HTML endpoint through the same throttle and retry policy (never cached)
//   redactUrl — Strip API keys/tokens from a URL before it is ever logged
//   resetSteamHttpState — Drop cache and throttle state (tests and manual scripts)
//   steamHttpStats — Counters for requests, cache hits and retries
//   steamMinIntervalMs — Configured minimum gap between requests
// END_MODULE_MAP

export const STEAM_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_INTERVAL_MS = 250; // 4 requests per second is well under Steam's tolerance

interface CacheEntry {
    expiresAt: number;
    value: unknown;
}

interface SteamHttpState {
    lastRequestAt: number;
    cache: Map<string, CacheEntry>;
    requests: number;
    cacheHits: number;
    retries: number;
    chain: Promise<void>;
}

const globalForSteamHttp = globalThis as typeof globalThis & {
    steamMonitorSteamHttpState?: SteamHttpState;
};

const state = globalForSteamHttp.steamMonitorSteamHttpState ??= {
    lastRequestAt: 0,
    cache: new Map(),
    requests: 0,
    cacheHits: 0,
    retries: 0,
    chain: Promise.resolve(),
};

export function steamMinIntervalMs(): number {
    const configured = Number.parseInt(process.env.STEAM_MIN_INTERVAL_MS ?? "", 10);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MIN_INTERVAL_MS;
}

export function resetSteamHttpState(): void {
    state.lastRequestAt = 0;
    state.cache.clear();
    state.requests = 0;
    state.cacheHits = 0;
    state.retries = 0;
    state.chain = Promise.resolve();
}

export function steamHttpStats(): { requests: number; cacheHits: number; retries: number } {
    return { requests: state.requests, cacheHits: state.cacheHits, retries: state.retries };
}

// START_CONTRACT: waitForSlot
//   PURPOSE: Serialize every caller onto a single request queue so the gap is enforced between
//            requests, not just before the first one — a bare "last request" timestamp lets
//            concurrent callers (e.g. a Promise.all batch) all read the same stale value and
//            fire together, so each caller instead chains onto the previous caller's completed
//            turn before it computes its own wait
//   INPUTS: none
//   OUTPUTS: { Promise<void> — resolves once this caller has waited its turn and claimed the slot }
//   SIDE_EFFECTS: mutates state.lastRequestAt and state.chain; may sleep via setTimeout
//   LINKS: M-STEAMHTTP
// END_CONTRACT: waitForSlot
// START_BLOCK_THROTTLE_QUEUE
// A module-wide promise chain — not just a last-request timestamp — is what actually
// serializes concurrent callers. Two calls racing on `waitForSlot` would otherwise both
// read the same `lastRequestAt`, compute the same wait, and fire together; chaining each
// call onto the previous one forces them through the gate one at a time.
function waitForSlot(): Promise<void> {
    const turn = state.chain.then(async () => {
        const gap = steamMinIntervalMs();
        if (gap > 0) {
            const wait = state.lastRequestAt + gap - Date.now();
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        state.lastRequestAt = Date.now();
    });
    state.chain = turn.catch(() => undefined);
    return turn;
}
// END_BLOCK_THROTTLE_QUEUE

const SENSITIVE_QUERY_PARAMS = ["key", "apikey", "token", "access_token"];

// START_CONTRACT: redactUrl
//   PURPOSE: Strip sensitive query parameter values (Steam API keys, tokens) from a URL before
//            it is logged — every Steam Web API URL this service builds carries the API key in
//            the query string, and these warnings go to the container log
//   INPUTS: { url: string }
//   OUTPUTS: { string — the URL with any SENSITIVE_QUERY_PARAMS value replaced by "***";
//              origin+path only (no query at all) if the URL cannot be parsed }
//   SIDE_EFFECTS: none
//   LINKS: M-STEAMHTTP
// END_CONTRACT: redactUrl
// Redact before logging, never after: if this function is skipped or throws, nothing here
// falls back to logging the raw string with the query intact.
function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const sensitiveNames = Array.from(parsed.searchParams.keys())
            .filter(name => SENSITIVE_QUERY_PARAMS.includes(name.toLowerCase()));
        for (const name of sensitiveNames) {
            parsed.searchParams.set(name, "***");
        }
        return parsed.toString();
    } catch {
        // Not a parseable absolute URL — never guess at redacting a query string we can't
        // inspect. Origin and path only.
        return url.split("?")[0];
    }
}

// START_CONTRACT: retryDelayMs
//   PURPOSE: Decide whether a failed Steam call is worth retrying, and after how long
//   INPUTS: { status: number - Steam HTTP response status, attempt: number - 1-based attempt count }
//   OUTPUTS: { number | null - Delay in ms before the next attempt, or null when the error is not retryable }
//   SIDE_EFFECTS: none
//   LINKS: M-STEAMHTTP
// END_CONTRACT: retryDelayMs
function retryDelayMs(status: number, attempt: number): number | null {
    if (status === 429) return 2000 * attempt;
    if (status >= 500) return 500 * 2 ** (attempt - 1);
    return null; // retrying any 4xx other than 429 is pointless
}

// START_CONTRACT: steamFetchJson
//   PURPOSE: Fetch one Steam JSON endpoint with rate limiting, retries and optional caching
//   INPUTS: { url: string, options?: { cacheTtlMs?: number, cacheIf?: (value: T) => boolean,
//              onHttpError?: (status: number, bodyText: string | null) => void } }
//            cacheIf is deliberately optional and generic: this gateway does not know what
//            "success" means for an arbitrary Steam endpoint (an HTTP-200 body can still carry
//            a negative verdict, e.g. Steam's own `{"<id>":{"success":false}}`), so a caller
//            that cares about that distinction supplies the predicate; without one, any
//            HTTP-200 body is cacheable, matching this gateway's original behavior.
//            onHttpError is the same idea for failure diagnostics: the gateway cannot know
//            which non-retryable status codes are noteworthy for a given endpoint (Steam's
//            GetPlayerAchievements sends a body-carried reason on 403, but a 400 there just
//            means "this app has no achievements" — a normal, high-volume answer), so a caller
//            that cares supplies this callback instead of the gateway guessing generically.
//            It only fires for a non-retryable status (429 and 5xx stay the gateway's own
//            generic warning); when it fires, the gateway's own warning for that failure is
//            skipped, handing the caller full ownership of whether/how to log it.
//   OUTPUTS: { Promise<T | null> — null when Steam stayed unavailable }
//   SIDE_EFFECTS: HTTP GET; mutates in-process cache and counters
//   LINKS: M-STEAMHTTP, M-STEAM
// END_CONTRACT: steamFetchJson
export async function steamFetchJson<T>(
    url: string,
    options?: {
        cacheTtlMs?: number;
        cacheIf?: (value: T) => boolean;
        onHttpError?: (status: number, bodyText: string | null) => void;
    },
): Promise<T | null> {
    // START_BLOCK_CACHE_LOOKUP
    const ttl = options?.cacheTtlMs ?? 0;
    if (ttl > 0) {
        const hit = state.cache.get(url);
        if (hit && hit.expiresAt > Date.now()) {
            state.cacheHits++;
            return hit.value as T;
        }
    }
    // END_BLOCK_CACHE_LOOKUP

    for (let attempt = 1; attempt <= STEAM_MAX_ATTEMPTS; attempt++) {
        await waitForSlot();
        state.requests++;

        try {
            const res = await fetch(url);

            if (res.ok) {
                const value = await res.json() as T;
                // A failed HTTP response is never written to the cache above this line, but a
                // successful one can still carry a negative body (Steam answers an unavailable
                // app with HTTP 200). cacheIf is the caller's say on whether *this* value is
                // worth remembering; omitting it means "any 200 body is fine to cache".
                if (ttl > 0 && (!options?.cacheIf || options.cacheIf(value))) {
                    state.cache.set(url, { expiresAt: Date.now() + ttl, value });
                }
                return value;
            }

            const delay = retryDelayMs(res.status, attempt);
            if (delay === null && options?.onHttpError) {
                // Not retryable, and the caller owns this endpoint's failure semantics — read
                // the body defensively (a second read after res.json() never happened here, but
                // a body that isn't readable at all must not crash the caller) and hand off
                // instead of guessing at a generic message.
                let bodyText: string | null;
                try {
                    bodyText = await res.text();
                } catch {
                    bodyText = null;
                }
                options.onHttpError(res.status, bodyText);
            } else {
                console.warn(`[M-STEAMHTTP] HTTP ${res.status} for ${redactUrl(url)} (attempt ${attempt})`);
            }
            if (delay === null || attempt === STEAM_MAX_ATTEMPTS) return null;

            state.retries++;
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (error) {
            console.warn(`[M-STEAMHTTP] Network error for ${redactUrl(url)} (attempt ${attempt}):`, error);
            if (attempt === STEAM_MAX_ATTEMPTS) return null;
            state.retries++;
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
    }

    return null;
}

// START_CONTRACT: steamFetchText
//   PURPOSE: Fetch one Steam HTML endpoint through the same throttle and retry policy
//   INPUTS: { url: string }
//   OUTPUTS: { Promise<string | null> }
//   SIDE_EFFECTS: HTTP GET; mutates counters
//   LINKS: M-STEAMHTTP
// END_CONTRACT: steamFetchText
export async function steamFetchText(url: string): Promise<string | null> {
    // Mirrors steamFetchJson's throttle/retry loop exactly, but returns the raw body instead of
    // parsing it as JSON — Steam's HTML search pages carry markup, not a JSON envelope, and this
    // gateway never caches the result (search and store pages change too often for a TTL to help).
    for (let attempt = 1; attempt <= STEAM_MAX_ATTEMPTS; attempt++) {
        await waitForSlot();
        state.requests++;

        try {
            const res = await fetch(url);
            if (res.ok) return await res.text();

            const delay = retryDelayMs(res.status, attempt);
            console.warn(`[M-STEAMHTTP] HTTP ${res.status} for ${redactUrl(url)} (attempt ${attempt})`);
            if (delay === null || attempt === STEAM_MAX_ATTEMPTS) return null;

            state.retries++;
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (error) {
            console.warn(`[M-STEAMHTTP] Network error for ${redactUrl(url)} (attempt ${attempt}):`, error);
            if (attempt === STEAM_MAX_ATTEMPTS) return null;
            state.retries++;
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
    }

    return null;
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Extracted throttling, retry and caching out of steam.ts]
//   LAST_CHANGE_2: [v1.1.0 - Added optional cacheIf predicate so callers can refuse to cache an HTTP-200 negative body]
//   LAST_CHANGE_3: [v1.2.0 - Added steamFetchText so Steam's HTML endpoints share the same throttle and retry policy]
//   LAST_CHANGE_4: [v1.3.0 - Redact API keys/tokens from every logged URL; added onHttpError so a caller can own non-retryable-status diagnostics instead of the gateway guessing]
// END_CHANGE_SUMMARY
