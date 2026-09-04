import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { runLiveCheck } from "./rankCheckPaths";

const mocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult: vi.fn(),
  MAX_TASKS_PER_POST: 100,
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));

describe("runLiveCheck", () => {
  beforeEach(() => {
    mocks.insertSnapshots.mockResolvedValue(undefined);
    mocks.updateRun.mockResolvedValue(undefined);
  });

  it("continues later batches and returns actionable keyword/device failures", async () => {
    const rankCheck = vi.fn(async (input: { keywordId: string }) => {
      if (input.keywordId === "kw_1") {
        throw new AppError("RATE_LIMITED", "DataForSEO HTTP 429");
      }
      return {
        keywordId: input.keywordId,
        keyword: `keyword ${input.keywordId}`,
        position: null,
        url: null,
        serpFeatures: [],
      };
    });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workflow steps are executed directly by the pgStep mock
    const result = await runLiveCheck({} as WorkflowStep, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the rankCheck seam is used by this unit test
      client: { serp: { rankCheck } } as never,
      keywords: Array.from({ length: 11 }, (_, index) => ({
        id: `kw_${index + 1}`,
        keyword: `keyword ${index + 1}`,
      })),
      devices: "desktop",
      serpDepth: 10,
      domain: "example.com",
      locationCode: 2840,
      languageCode: "en",
      runId: "run_1",
    });

    expect(rankCheck).toHaveBeenCalledTimes(11);
    expect(result).toEqual({
      checkedTasks: 10,
      failures: [
        expect.objectContaining({
          keywordId: "kw_1",
          keyword: "keyword 1",
          device: "desktop",
          code: "RATE_LIMITED",
          message: "DataForSEO HTTP 429",
        }),
      ],
    });
    expect(mocks.insertSnapshots).toHaveBeenCalledTimes(2);
  });
});
