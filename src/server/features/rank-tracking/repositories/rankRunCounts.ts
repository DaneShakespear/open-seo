import { and, count, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { rankCheckRuns } from "@/db/schema";

export async function countRunsStartedSince(input: {
  configId: string;
  sinceIso: string;
  status: "pending" | "running" | "completed" | "failed";
}) {
  const rows = await db
    .select({ value: count() })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, input.configId),
        eq(rankCheckRuns.status, input.status),
        gte(rankCheckRuns.startedAt, input.sinceIso),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}
