// web/lib/growth-history.ts
// What has brought the clinic patients, in numbers — the standing knowledge
// the assistant reasons from when it suggests what to write and where.
//
// This is the lead history the team pulled from HubSpot and the ad accounts
// on 30 September 2026, kept in one dated place. Metricool's engagement
// numbers (lib/workspace-snapshot.ts performanceBlock) say what got
// attention; this says what got PATIENTS, which is not the same thing, and
// the assistant is told both. Update the block when the team pulls new
// numbers; the date at the top is part of the fact.
//
// Pure, no imports: read by the playbook, the voice session and the tests.

export const GROWTH_HISTORY_AS_OF = '30 September 2026';

export const GROWTH_HISTORY = `# WHAT HAS BROUGHT PATIENTS (lead history as of ${GROWTH_HISTORY_AS_OF})

- High: Dec 2024 to Mar 2025, 605 to 747 new contacts a month, from Google Search campaigns on
  specific searches — "stem cell treatment", the competitor "CPI", "anti-aging", doctor and
  hospital searches — each lead tagged to its campaign. January 2025 (747) is still the best month.
- Low: Sept to Dec 2025, 92 to 120 a month; the tagged Google campaigns had nearly disappeared,
  most leads had no traceable campaign, Meta was off (budget cut or restructure: unknown, since
  Metricool holds no Google Ads spend for 2025).
- 2026: rebuilt Meta brought 541 in August and 617 in September, until Meta spend stopped on
  19 September 2026.
- Leads are not patients: over two years Meta brought 1,635 contacts and 7 patients; Direct
  traffic turned 19% of contacts into patients, Google Search 1.4%. Recent contacts are still
  converting, so the latest figures will rise.

So: search intent converts, reach does not — content that ranks for what people search when
ready ("stem cell treatment", "anti-aging", doctor/hospital and clinic-name searches, "CPI")
outweighs content that only travels; Direct converts best, so write so the CLINIC is what is
remembered; Meta is volume and awareness, judged by patients, never by contacts. Say these
numbers when choosing what to write, where and when, and say whether a suggestion rests on
attention (engagement) or on patients (this history).`;
