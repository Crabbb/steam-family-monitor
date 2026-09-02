// FILE: src/lib/userHealth.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Hold the single shared constant that defines when a user's Steam profile is
//            considered broken, with zero dependencies of its own
//   SCOPE: USER_FAILURE_ALERT_THRESHOLD only
//   DEPENDS: none
//   LINKS: M-CORE, M-UI
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   USER_FAILURE_ALERT_THRESHOLD — Consecutive per-user poll failures that trigger one Telegram alert and the users-page marker
// END_MODULE_MAP

// This constant is deliberately not defined in core.ts, even though core.ts is where it is
// consumed for the alert threshold. core.ts imports Prisma, the Steam client and the Telegram
// client at module scope (real side effects, e.g. `new PrismaLibSql(...)`) — server-only, and in
// Prisma's case Node-only. src/app/users/page.tsx is a "use client" component that renders the
// same threshold as a UI marker; importing it from core.ts would drag every one of those
// server-only modules into the browser bundle. A module with no imports at all is safe from
// either side of that boundary, and keeping the constant in exactly one place means the alert
// and the marker can never silently drift to different numbers.
export const USER_FAILURE_ALERT_THRESHOLD = 3;

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Extracted from core.ts so the client-side users-page marker and the server-side alert threshold share one definition instead of two hand-kept-in-sync literals]
// END_CHANGE_SUMMARY
