import type { BillingCustomerContext } from "@/server/billing/subscription";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";
import { countRunsStartedSince } from "@/server/features/rank-tracking/repositories/rankRunCounts";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  isScheduledRankTrackingInterval,
  nextCheckAtAfterFailedRun,
  nextCheckAtAfterSuccessfulRun,
  rankCheckFailureReason,
} from "@/shared/rank-tracking";
import type {
  LiveCheckStats,
  QueuedCheckStats,
} from "@/server/workflows/rankCheckPaths";

export async function settleRankCheckRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: "manual" | "scheduled";
  devices: "both" | "desktop" | "mobile";
  batchError: string | null;
  liveStats: LiveCheckStats | null;
  queueStats: QueuedCheckStats | null;
  keywordsTotalOnRun: number;
}) {
  const nowIso = new Date().toISOString();
  const snapshots = await RankTrackingRepository.getSnapshotsForRun(
    input.runId,
  );
  const keywordsChecked = new Set(snapshots.map((s) => s.trackingKeywordId))
    .size;
  const keywordsTotal = input.keywordsTotalOnRun || keywordsChecked;
  const incompleteCount = keywordsTotal - keywordsChecked;
  const expectedChecks = keywordsTotal * (input.devices === "both" ? 2 : 1);
  const incompleteChecks = Math.max(0, expectedChecks - snapshots.length);
  const providerFailures = [
    ...(input.liveStats?.failures ?? []),
    ...(input.queueStats?.fallbackFailures ?? []),
  ];
  const providerFailureSummary = providerFailures.length
    ? providerFailures
        .map(
          (failure) =>
            `"${failure.keyword}" [${failure.device}] ${failure.code}: ${failure.message}${failure.chargedCostUsd !== undefined ? ` (provider charge $${failure.chargedCostUsd.toFixed(4)})` : ""}`,
        )
        .join("; ")
        .slice(0, 1600)
    : null;

  const config = await RankTrackingRepository.getConfigById({
    configId: input.configId,
    projectId: input.projectId,
  });
  const scheduleInterval =
    config && isScheduledRankTrackingInterval(config.scheduleInterval)
      ? config.scheduleInterval
      : null;

  // Zero stored snapshots means the run learned nothing. That includes a
  // DataForSEO 402 on every task, which used to be logged per call and then
  // finalized as a completed check. Marking it completed updated lastCheckedAt
  // and left the scheduler's already-advanced nextCheckAt in place, so the
  // weekly slot was skipped.
  if (snapshots.length === 0 && expectedChecks > 0) {
    await recordEmptyRankCheck({
      ...input,
      nowIso,
      keywordsChecked,
      keywordsTotal,
      incompleteChecks,
      expectedChecks,
      providerFailureSummary,
      providerFailures,
      scheduleInterval,
    });
    return;
  }

  let errorMessage: string | undefined;
  if (input.batchError) {
    errorMessage = `Completed ${keywordsChecked} of ${keywordsTotal} keyword(s). Error: ${input.batchError}`;
  } else if (providerFailureSummary) {
    errorMessage = `${incompleteChecks} of ${expectedChecks} keyword/device check(s) failed. Provider failures: ${providerFailureSummary}`;
  } else if (incompleteChecks > 0) {
    errorMessage = `${incompleteChecks} of ${expectedChecks} keyword/device check(s) could not be checked`;
  } else if (incompleteCount > 0) {
    errorMessage = `${incompleteCount} keyword(s) could not be checked`;
  }

  await RankTrackingRepository.updateRun(input.runId, {
    status: "completed",
    keywordsChecked,
    completedAt: nowIso,
    ...(errorMessage ? { errorMessage } : {}),
  });

  // The cron claims the slot before the run starts. Replace that claim with
  // lastCheckedAt plus the interval so a weekly tracker is due 7 days after
  // the check that actually stored results. Monthly keeps its month-end anchor.
  const cadence =
    scheduleInterval === "daily" || scheduleInterval === "weekly"
      ? scheduleInterval
      : null;
  await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
    lastCheckedAt: nowIso,
    lastSkipReason: null,
    ...(cadence
      ? { nextCheckAt: nextCheckAtAfterSuccessfulRun(cadence, nowIso) }
      : {}),
  });

  const queueSummary = input.queueStats
    ? ` queue_tasks=${input.queueStats.queueTasks} queue_collected=${input.queueStats.queueCollected} fallback_tasks=${input.queueStats.fallbackTasks} fallback_checked=${input.queueStats.fallbackChecked}`
    : "";
  const errorSummary = errorMessage
    ? ` error="${errorMessage.replace(/\s+/g, " ").slice(0, 200)}"`
    : "";
  console.log(
    `[rank-check] ${input.runId} completed org=${input.billingCustomer.organizationId} project=${input.projectId} trigger=${input.trigger} keywords=${keywordsChecked}/${keywordsTotal}${queueSummary}${errorSummary}`,
  );

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status: "completed",
      trigger: input.trigger,
      keywords_checked: keywordsChecked,
      ...(input.queueStats
        ? {
            queue_tasks: input.queueStats.queueTasks,
            queue_collected: input.queueStats.queueCollected,
            fallback_tasks: input.queueStats.fallbackTasks,
            fallback_checked: input.queueStats.fallbackChecked,
          }
        : {}),
    },
  });
}

async function recordEmptyRankCheck(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: "manual" | "scheduled";
  nowIso: string;
  keywordsChecked: number;
  keywordsTotal: number;
  incompleteChecks: number;
  expectedChecks: number;
  batchError: string | null;
  providerFailureSummary: string | null;
  providerFailures: Array<{ code: string; message: string }>;
  scheduleInterval: "daily" | "weekly" | "monthly" | null;
}) {
  const reason = rankCheckFailureReason({
    batchError: input.batchError,
    failures: input.providerFailures,
  });
  let errorMessage: string;
  if (input.batchError) {
    errorMessage = `Stored no results for ${input.keywordsTotal} keyword(s). Error: ${input.batchError}`;
  } else if (input.providerFailureSummary) {
    errorMessage = `${input.incompleteChecks} of ${input.expectedChecks} keyword/device check(s) failed. Provider failures: ${input.providerFailureSummary}`;
  } else {
    errorMessage = `Rank check stored no results for ${input.keywordsTotal} keyword(s).`;
  }

  let nextCheckAt: string | undefined;
  if (input.scheduleInterval) {
    const dayStart = new Date(input.nowIso);
    dayStart.setUTCHours(0, 0, 0, 0);
    const priorFailures = await countRunsStartedSince({
      configId: input.configId,
      sinceIso: toSqliteTimestamp(dayStart),
      status: "failed",
    });
    nextCheckAt = nextCheckAtAfterFailedRun(
      new Date(input.nowIso),
      priorFailures + 1,
    );
  }

  await RankTrackingRepository.updateRun(input.runId, {
    status: "failed",
    keywordsChecked: input.keywordsChecked,
    completedAt: input.nowIso,
    errorMessage,
  });
  await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
    lastSkipReason: reason,
    ...(nextCheckAt ? { nextCheckAt } : {}),
  });

  console.log(
    `[rank-check] ${input.runId} failed org=${input.billingCustomer.organizationId} project=${input.projectId} trigger=${input.trigger} reason=${reason} stored=0/${input.keywordsTotal}`,
  );
  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status: "failed",
      trigger: input.trigger,
      keywords_checked: 0,
      failure_reason: reason,
    },
  });
}
