import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeNextCheckAt,
  estimateRankCheckCredits,
  nextCheckAtAfterFailedRun,
  nextCheckAtAfterSuccessfulRun,
  rankCheckFailureReason,
  rankTrackerHealth,
  scheduleLabel,
} from "./rank-tracking";

describe("rank tracking cost estimates", () => {
  it.each([
    {
      method: "live" as const,
      keywordCount: 4,
      devices: "desktop" as const,
      depth: 10,
      costUsd: 0.01024,
      costCredits: 12,
    },
    {
      method: "live" as const,
      keywordCount: 1000,
      devices: "both" as const,
      depth: 40,
      costUsd: 16.64,
      costCredits: 18_000,
    },
    {
      method: "queued" as const,
      keywordCount: 104,
      devices: "desktop" as const,
      depth: 10,
      costUsd: 0.07987,
      costCredits: 81,
    },
    {
      method: "queued" as const,
      keywordCount: 1000,
      devices: "both" as const,
      depth: 40,
      costUsd: 4.992,
      costCredits: 5_000,
    },
  ])(
    "matches per-call billing for $method checks",
    ({ keywordCount, devices, depth, method, costUsd, costCredits }) => {
      expect(
        estimateRankCheckCredits(keywordCount, devices, depth, method),
      ).toEqual({ costUsd, costCredits });
    },
  );
});

describe("rank tracking schedules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels monthly schedules", () => {
    expect(scheduleLabel("monthly")).toBe("Monthly");
  });

  it("schedules new monthly configs for the end of the current month", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0);

    expect(computeNextCheckAt("monthly")).toBe("2026-01-31T04:00:00.000Z");
  });

  it("moves new monthly configs to next month when this month's run time has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T10:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0);

    expect(computeNextCheckAt("monthly")).toBe("2026-02-28T04:00:00.000Z");
  });

  it("advances monthly schedules on month end across shorter months", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    expect(computeNextCheckAt("monthly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-02-28T05:30:00.000Z",
    );
  });

  it("keeps advancing monthly schedules until the next check is in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    expect(computeNextCheckAt("monthly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-31T05:30:00.000Z",
    );
  });

  it("preserves the time-of-day anchor for heavily overdue daily schedules", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    expect(computeNextCheckAt("daily", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-11T05:30:00.000Z",
    );
  });

  it("preserves the weekday and time anchor for heavily overdue weekly schedules", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    // 2026-01-31 is a Saturday; every advance lands on a Saturday.
    expect(computeNextCheckAt("weekly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-14T05:30:00.000Z",
    );
  });

  it("schedules a successful weekly run 7 days after that check", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));

    // The old anchor walk would jump this to the next future Saturday.
    expect(
      nextCheckAtAfterSuccessfulRun("weekly", "2026-11-20T15:00:00.000Z"),
    ).toBe("2026-11-27T15:00:00.000Z");
  });

  it("retries a failed run in 3 hours, then waits until the next UTC day", () => {
    const now = new Date("2026-11-20T15:00:00.000Z");

    expect(nextCheckAtAfterFailedRun(now, 1)).toBe("2026-11-20T18:00:00.000Z");
    expect(nextCheckAtAfterFailedRun(now, 3)).toBe("2026-11-20T18:00:00.000Z");
    expect(nextCheckAtAfterFailedRun(now, 4)).toBe("2026-11-21T00:00:00.000Z");
  });
});

describe("rank check failure reasons", () => {
  it("names a 402 or 40200 failure as dataforseo_payment_required", () => {
    expect(
      rankCheckFailureReason({
        failures: [
          {
            code: "DATAFORSEO_PAYMENT_REQUIRED",
            message: "DataForSEO HTTP 402",
          },
        ],
      }),
    ).toBe("dataforseo_payment_required");
    expect(
      rankCheckFailureReason({
        failures: [
          {
            code: "INTERNAL_ERROR",
            message: "DataForSEO status 40200: Payment Required",
          },
        ],
      }),
    ).toBe("dataforseo_payment_required");
    expect(
      rankCheckFailureReason({
        batchError: null,
        failures: [],
      }),
    ).toBe("no_results");
  });

  it("exposes the last stored check and the current failure reason", () => {
    expect(
      rankTrackerHealth({
        lastCheckedAt: "2026-10-08T05:00:00.000Z",
        lastSkipReason: "dataforseo_payment_required",
      }),
    ).toEqual({
      lastSuccessfulRunAt: "2026-10-08T05:00:00.000Z",
      lastFailureReason: "dataforseo_payment_required",
    });
  });
});
