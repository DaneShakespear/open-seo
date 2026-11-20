import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import {
  prepareRankCheckKeywords,
  RankCheckWorkflow,
} from "./RankCheckWorkflow";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getRunById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  updateConfig: vi.fn(),
  updateRun: vi.fn(),
  countRunsStartedSince: vi.fn(),
  autumnCheck: vi.fn(),
  createDataforseoClient: vi.fn(),
  runLiveCheck: vi.fn(),
  failRunIfActive: vi.fn(),
  captureServerEvent: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: vi.fn(),
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock("@/server/features/rank-tracking/repositories/rankRunCounts", () => ({
  countRunsStartedSince: mocks.countRunsStartedSince,
}));
vi.mock("@/server/features/rank-tracking/services/rankCheckRunGuards", () => ({
  failRunIfActive: mocks.failRunIfActive,
}));
vi.mock("@/server/workflows/rankCheckPaths", () => ({
  runLiveCheck: mocks.runLiveCheck,
  runQueuedCheck: vi.fn(),
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: mocks.captureServerEvent,
}));
vi.mock("@/server/billing/autumn", () => ({
  autumn: { check: mocks.autumnCheck },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: "project_1",
};

const activeRun = {
  id: "run_1",
  status: "running",
  keywordsTotal: 1,
};

const weeklyConfig = {
  isActive: true,
  scheduleInterval: "weekly" as const,
};

function configUpdate(): Record<string, unknown> {
  const update = mocks.updateConfig.mock.calls.at(-1)?.[2];
  if (!update || typeof update !== "object") {
    throw new Error("expected updateConfig to be called with a patch");
  }
  return update as Record<string, unknown>;
}

describe("rank check workflow credit ceiling", () => {
  beforeEach(() => {
    mocks.getRunById.mockResolvedValue(activeRun);
    mocks.getConfigById.mockResolvedValue(weeklyConfig);
    mocks.updateRun.mockResolvedValue(undefined);
    mocks.updateConfig.mockResolvedValue(undefined);
    mocks.countRunsStartedSince.mockResolvedValue(0);
    mocks.getSnapshotsForRun.mockResolvedValue([]);
    mocks.runLiveCheck.mockResolvedValue({ checkedTasks: 0, failures: [] });
    mocks.isHostedServerAuthMode.mockResolvedValue(true);
    mocks.autumnCheck.mockResolvedValue({ balance: { remaining: 1_000 } });
  });

  it("rejects a keyword-list race before balance or DataForSEO calls", async () => {
    mocks.getConfigById.mockResolvedValue({ isActive: true });
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: `kw_${index}`,
        keyword: `keyword ${index}`,
      })),
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocked base class does not inspect Worker constructor context
    const workflow = new RankCheckWorkflow({} as ExecutionContext, {} as Env);

    await expect(
      workflow.run(
        {
          instanceId: "run_1",
          timestamp: new Date(),
          payload: {
            runId: "run_1",
            configId: "config_1",
            billingCustomer,
            projectId: "project_1",
            domain: "example.com",
            locationCode: 2840,
            languageCode: "en",
            devices: "desktop",
            serpDepth: 10,
            trigger: "manual",
            maxCostCredits: 12,
          },
        },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workflow steps are executed directly by the pgStep mock
        {} as WorkflowStep,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(mocks.autumnCheck).not.toHaveBeenCalled();
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(mocks.runLiveCheck).not.toHaveBeenCalled();
  });

  it("accepts the same reloaded list at the approved ceiling", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({
        id: `kw_${index}`,
        keyword: `keyword ${index}`,
      })),
    );

    const result = await prepareRankCheckKeywords({
      runId: "run_1",
      configId: "config_1",
      billingCustomer,
      devices: "desktop",
      serpDepth: 10,
      trigger: "manual",
      maxCostCredits: 12,
    });

    expect(result.keywords).toHaveLength(4);
    expect(mocks.autumnCheck).toHaveBeenCalledTimes(2);
  });

  it("preserves callers that do not provide a ceiling", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: `kw_${index}`,
        keyword: `keyword ${index}`,
      })),
    );
    mocks.isHostedServerAuthMode.mockResolvedValue(false);

    const result = await prepareRankCheckKeywords({
      runId: "run_1",
      configId: "config_1",
      billingCustomer,
      devices: "desktop",
      serpDepth: 10,
      trigger: "manual",
    });

    expect(result.keywords).toHaveLength(5);
    expect(mocks.autumnCheck).not.toHaveBeenCalled();
  });

  it("persists actionable keyword/device provider failures", async () => {
    mocks.getConfigById.mockResolvedValue({ isActive: true });
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "las vegas limo" },
    ]);
    mocks.isHostedServerAuthMode.mockResolvedValue(false);
    mocks.createDataforseoClient.mockReturnValue({});
    mocks.runLiveCheck.mockResolvedValue({
      checkedTasks: 0,
      failures: [
        {
          keywordId: "kw_1",
          keyword: "las vegas limo",
          device: "mobile",
          code: "RATE_LIMITED",
          message: "DataForSEO HTTP 429",
        },
      ],
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocked base class does not inspect Worker constructor context
    const workflow = new RankCheckWorkflow({} as ExecutionContext, {} as Env);

    await workflow.run(
      {
        instanceId: "run_1",
        timestamp: new Date(),
        payload: {
          runId: "run_1",
          configId: "config_1",
          billingCustomer,
          projectId: "project_1",
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
          devices: "mobile",
          serpDepth: 10,
          trigger: "manual",
        },
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workflow steps are executed directly by the pgStep mock
      {} as WorkflowStep,
    );

    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "failed",
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally dynamic
        errorMessage: expect.stringContaining(
          '"las vegas limo" [mobile] RATE_LIMITED: DataForSEO HTTP 429',
        ),
      }),
    );
    expect(configUpdate()).not.toHaveProperty("lastCheckedAt");
    expect(configUpdate().lastSkipReason).toBe("no_results");
  });
});

describe("rank check run settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T15:00:00.000Z"));
    mocks.getRunById.mockResolvedValue(activeRun);
    mocks.getConfigById.mockResolvedValue(weeklyConfig);
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "open seo" },
    ]);
    mocks.updateRun.mockResolvedValue(undefined);
    mocks.updateConfig.mockResolvedValue(undefined);
    mocks.countRunsStartedSince.mockResolvedValue(0);
    mocks.getSnapshotsForRun.mockResolvedValue([]);
    mocks.isHostedServerAuthMode.mockResolvedValue(false);
    mocks.createDataforseoClient.mockReturnValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runManualCheck() {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocked base class does not inspect Worker constructor context
    const workflow = new RankCheckWorkflow({} as ExecutionContext, {} as Env);
    await workflow.run(
      {
        instanceId: "run_1",
        timestamp: new Date("2026-11-20T15:00:00.000Z"),
        payload: {
          runId: "run_1",
          configId: "config_1",
          billingCustomer,
          projectId: "project_1",
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
          devices: "desktop",
          serpDepth: 10,
          trigger: "manual",
        },
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workflow steps are executed directly by the pgStep mock
      {} as WorkflowStep,
    );
  }

  it("marks a run that stores no results as failed and retries it", async () => {
    mocks.runLiveCheck.mockResolvedValue({ checkedTasks: 0, failures: [] });

    await runManualCheck();

    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(configUpdate()).not.toHaveProperty("lastCheckedAt");
    expect(configUpdate().lastSkipReason).toBe("no_results");
    expect(configUpdate().nextCheckAt).toBe("2026-11-20T18:00:00.000Z");
  });

  it("records a DataForSEO 402 as dataforseo_payment_required", async () => {
    mocks.runLiveCheck.mockResolvedValue({
      checkedTasks: 0,
      failures: [
        {
          keywordId: "kw_1",
          keyword: "open seo",
          device: "desktop",
          code: "DATAFORSEO_PAYMENT_REQUIRED",
          message: "DataForSEO HTTP 402",
        },
      ],
    });

    await runManualCheck();

    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "failed",
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally dynamic
        errorMessage: expect.stringContaining("402"),
      }),
    );
    expect(configUpdate()).not.toHaveProperty("lastCheckedAt");
    expect(configUpdate().lastSkipReason).toBe("dataforseo_payment_required");
    expect(configUpdate().nextCheckAt).toBe("2026-11-20T18:00:00.000Z");
  });

  it("schedules the next weekly check 7 days after a successful run", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([
      { trackingKeywordId: "kw_1", device: "desktop" },
    ]);
    mocks.runLiveCheck.mockResolvedValue({ checkedTasks: 1, failures: [] });

    await runManualCheck();

    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "completed" }),
    );
    expect(configUpdate().lastCheckedAt).toBe("2026-11-20T15:00:00.000Z");
    expect(configUpdate().lastSkipReason).toBeNull();
    expect(configUpdate().nextCheckAt).toBe("2026-11-27T15:00:00.000Z");
  });

  it("stops retrying a persistent failure until the next UTC day", async () => {
    mocks.countRunsStartedSince.mockResolvedValue(3);
    mocks.runLiveCheck.mockResolvedValue({
      checkedTasks: 0,
      failures: [
        {
          keywordId: "kw_1",
          keyword: "open seo",
          device: "desktop",
          code: "INTERNAL_ERROR",
          message: "DataForSEO status 40200: Payment Required",
        },
      ],
    });

    await runManualCheck();

    expect(configUpdate().lastSkipReason).toBe("dataforseo_payment_required");
    expect(configUpdate().nextCheckAt).toBe("2026-11-21T00:00:00.000Z");
  });
});
