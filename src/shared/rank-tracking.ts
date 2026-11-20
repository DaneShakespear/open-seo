import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  SEO_DATA_COST_MARKUP,
  roundUsdForBilling,
} from "./billing";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

// ---------------------------------------------------------------------------
// Cost constants
// ---------------------------------------------------------------------------

/** DataForSEO Live API: cost of first page (10 results) */
const LIVE_BASE_PAGE_COST_USD = 0.002;

/** DataForSEO Live API: cost of each additional page (75% of base) */
const LIVE_EXTRA_PAGE_COST_USD = 0.0015;

/** DataForSEO task queue (standard priority): cost of first page (10 results) */
const QUEUED_BASE_PAGE_COST_USD = 0.0006;

/** DataForSEO task queue (standard priority): cost of each additional page (75% of base) */
const QUEUED_EXTRA_PAGE_COST_USD = 0.00045;

/**
 * How a rank check reaches DataForSEO: "live" is the instant endpoint used for
 * manual checks; "queued" is the cheaper task queue used for scheduled checks.
 */
type RankCheckMethod = "live" | "queued";

/** How many keywords are checked per batch */
export const KEYWORDS_PER_BATCH = 10;

/** Approximate seconds per batch */
export const SECONDS_PER_BATCH = 6;

/** Soft application limit for keywords per rank tracking config */
export const MAX_KEYWORDS_PER_CONFIG = 1000;

/** Maximum length of a single tracked keyword */
export const MAX_TRACKED_KEYWORD_LENGTH = 200;

/** Maximum configs (domain+location combos) per project */
export const MAX_CONFIGS_PER_PROJECT = 500;

/** Maximum queued rank-check tasks DataForSEO accepts in one task_post. */
export const MAX_TASKS_PER_POST = 100;

export const rankCheckCostApprovalError = (
  costCredits: number,
  maxCostCredits: number,
) => {
  return `The current rank check costs ${costCredits} credits, above the approved maximum of ${maxCostCredits}. Call estimate_rank_tracker_cost again and ask the user to approve the updated amount.`;
};

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** DataForSEO cost for a single SERP request at the given depth. */
function costPerSerpAtDepth(depth: number, method: RankCheckMethod): number {
  const pages = depth / 10;
  return method === "queued"
    ? QUEUED_BASE_PAGE_COST_USD + (pages - 1) * QUEUED_EXTRA_PAGE_COST_USD
    : LIVE_BASE_PAGE_COST_USD + (pages - 1) * LIVE_EXTRA_PAGE_COST_USD;
}

export function depthToPages(depth: number): number {
  return depth / 10;
}

export function pagesToDepth(pages: number): number {
  return pages * 10;
}

export function estimateRankCheckCredits(
  keywordCount: number,
  devices: RankTrackingConfig["devices"],
  depth: number,
  method: RankCheckMethod,
) {
  const totalChecks = keywordCount * devicesCount(devices);
  const checksPerMeteredCall = method === "queued" ? MAX_TASKS_PER_POST : 1;
  let costUsd = 0;
  let costCredits = 0;

  // Metering rounds and ceilings each provider call independently. Live rank
  // checks make one call per keyword/device pair, while queued checks post up
  // to MAX_TASKS_PER_POST pairs per call. Summing one aggregate and rounding
  // once can therefore understate the credits that will actually be charged.
  for (let offset = 0; offset < totalChecks; offset += checksPerMeteredCall) {
    const checksInCall = Math.min(checksPerMeteredCall, totalChecks - offset);
    const callCostUsd = roundUsdForBilling(
      checksInCall * costPerSerpAtDepth(depth, method) * SEO_DATA_COST_MARKUP,
    );
    costUsd += callCostUsd;
    costCredits += Math.ceil(callCostUsd * AUTUMN_SEO_DATA_CREDITS_PER_USD);
  }

  // This is the nominal queued task_post estimate. Rejected, failed, or
  // timed-out tasks can later incur additional live-fallback spend.
  costUsd = roundUsdForBilling(costUsd);
  return { costUsd, costCredits };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type ScheduledRankTrackingInterval = Exclude<
  RankTrackingConfig["scheduleInterval"],
  "manual"
>;

// Values written to rank_tracking_configs.last_skip_reason (free-form text in
// the schema; this union keeps writers and UI comparisons in sync).
export type RankTrackingSkipReason =
  | "plan_required"
  | "no_keywords"
  | "insufficient_credits"
  | "dataforseo_payment_required"
  | "no_results";

// A failed rank check is retried on a short delay. After this many failed
// attempts in the UTC day, the next attempt waits until the following UTC
// midnight so a standing DataForSEO 402 cannot restart every scheduler tick.
export const RANK_CHECK_RETRY_DELAY_MS = 3 * 60 * 60 * 1000;
export const RANK_CHECK_MAX_ATTEMPTS_PER_UTC_DAY = 4;

export function isDataforseoPaymentFailureSignal(
  code: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (code === "DATAFORSEO_PAYMENT_REQUIRED") return true;
  const text = message?.toLowerCase() ?? "";
  return (
    text.includes("payment required") ||
    text.includes("40200") ||
    text.includes("http 402")
  );
}

export function rankCheckFailureReason(input: {
  batchError?: string | null;
  failures: Array<{ code: string; message: string }>;
}): Extract<
  RankTrackingSkipReason,
  "dataforseo_payment_required" | "no_results"
> {
  const payment = input.failures.some((failure) =>
    isDataforseoPaymentFailureSignal(failure.code, failure.message),
  );
  if (
    payment ||
    isDataforseoPaymentFailureSignal(undefined, input.batchError)
  ) {
    return "dataforseo_payment_required";
  }
  return "no_results";
}

/**
 * Next slot after a run that stored results. Weekly and daily advance from
 * that run's timestamp, not from the previous schedule anchor: the anchor can
 * sit several days away from the last stored check, and a later empty run
 * then pushes the slot a full interval past it.
 */
export function nextCheckAtAfterSuccessfulRun(
  interval: ScheduledRankTrackingInterval,
  lastCheckedAtIso: string,
): string {
  const checkedAt = new Date(lastCheckedAtIso);
  if (Number.isNaN(checkedAt.getTime())) {
    throw new Error(`Invalid lastCheckedAt: ${lastCheckedAtIso}`);
  }
  if (interval === "monthly") {
    return computeNextCheckAt("monthly", lastCheckedAtIso);
  }
  const days = interval === "daily" ? 1 : 7;
  return new Date(checkedAt.getTime() + days * 86_400_000).toISOString();
}

/** `attemptsToday` includes the failure being recorded. */
export function nextCheckAtAfterFailedRun(
  now: Date,
  attemptsToday: number,
): string {
  if (attemptsToday >= RANK_CHECK_MAX_ATTEMPTS_PER_UTC_DAY) {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
  }
  return new Date(now.getTime() + RANK_CHECK_RETRY_DELAY_MS).toISOString();
}

export function rankTrackerHealth(config: {
  lastCheckedAt?: string | null;
  lastSkipReason?: string | null;
  lastSuccessfulRunAt?: string | null;
  lastFailureReason?: string | null;
}): {
  lastSuccessfulRunAt: string | null;
  lastFailureReason: string | null;
} {
  return {
    lastSuccessfulRunAt:
      config.lastSuccessfulRunAt ?? config.lastCheckedAt ?? null,
    lastFailureReason:
      config.lastFailureReason ?? config.lastSkipReason ?? null,
  };
}

export function estimateScheduledRankCheckCredits(
  keywordCount: number,
  devices: RankTrackingConfig["devices"],
  depth: number,
  scheduleInterval: ScheduledRankTrackingInterval,
) {
  const { costUsd, costCredits } = estimateRankCheckCredits(
    keywordCount,
    devices,
    depth,
    "queued",
  );
  const checksPerMonth =
    scheduleInterval === "daily" ? 30 : scheduleInterval === "weekly" ? 4 : 1;
  return {
    scheduleInterval,
    costUsd,
    costCredits,
    checksPerMonth,
    monthlyCostUsd: costUsd * checksPerMonth,
    monthlyCostCredits: costCredits * checksPerMonth,
  };
}

export function isScheduledRankTrackingInterval(
  interval: string | null | undefined,
): interval is ScheduledRankTrackingInterval {
  return (
    interval === "daily" || interval === "weekly" || interval === "monthly"
  );
}

function endOfMonthWithTime(source: Date, monthOffset = 0): Date {
  const endOfMonth = new Date(
    Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth() + monthOffset + 1,
      0,
    ),
  );
  endOfMonth.setUTCHours(
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
  return endOfMonth;
}

/**
 * Compute the next check time for a scheduled config.
 *
 * If `previousNextCheckAt` is provided, advances from that anchor by the
 * interval until the result is in the future. This prevents schedule drift
 * when runs are delayed (e.g., a weekly config due Monday that fires on
 * Wednesday will still schedule the next check for the following Monday).
 *
 * Otherwise a random hour (04–09 UTC) and minute are chosen.
 */
export function computeNextCheckAt(
  interval: ScheduledRankTrackingInterval,
  previousNextCheckAt?: string | null,
): string {
  const now = Date.now();

  if (interval === "monthly") {
    if (previousNextCheckAt) {
      const anchor = new Date(previousNextCheckAt);
      let monthOffset = 1;
      let nextDate = endOfMonthWithTime(anchor, monthOffset);
      while (nextDate.getTime() <= now) {
        monthOffset += 1;
        nextDate = endOfMonthWithTime(anchor, monthOffset);
      }
      return nextDate.toISOString();
    }

    const hour = 4 + Math.floor(Math.random() * 6);
    const minute = Math.floor(Math.random() * 60);
    const nextDate = endOfMonthWithTime(new Date());
    nextDate.setUTCHours(hour, minute, 0, 0);
    if (nextDate.getTime() <= now) {
      const followingMonth = endOfMonthWithTime(nextDate, 1);
      followingMonth.setUTCHours(hour, minute, 0, 0);
      return followingMonth.toISOString();
    }
    return nextDate.toISOString();
  }

  const daysAhead = interval === "daily" ? 1 : 7;

  if (previousNextCheckAt) {
    const anchor = new Date(previousNextCheckAt).getTime();
    const intervalMs = daysAhead * 86_400_000;
    const steps = Math.floor(Math.max(0, now - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs).toISOString();
  }

  const nextDate = new Date();
  nextDate.setUTCDate(nextDate.getUTCDate() + daysAhead);
  const hour = 4 + Math.floor(Math.random() * 6);
  const minute = Math.floor(Math.random() * 60);
  nextDate.setUTCHours(hour, minute, 0, 0);
  return nextDate.toISOString();
}

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

export function devicesLabel(devices: RankTrackingConfig["devices"]): string {
  if (devices === "both") return "Desktop + Mobile";
  return devices === "desktop" ? "Desktop" : "Mobile";
}

export function scheduleLabel(
  interval: RankTrackingConfig["scheduleInterval"],
): string {
  if (interval === "daily") return "Daily";
  if (interval === "weekly") return "Weekly";
  if (interval === "monthly") return "Monthly";
  return "Manual";
}

export function devicesCount(devices: RankTrackingConfig["devices"]): number {
  return devices === "both" ? 2 : 1;
}
