import { performance } from "node:perf_hooks";
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { describeError } from "./client.js";
import type { Options } from "./config.js";
import { batchQuestions, singleQuestions, STATE } from "./questions.js";

export interface Statistics {
  count: number;
  medianMs: number | null;
  meanMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export function statistics(values: readonly number[]): Statistics {
  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Latencies must be finite non-negative numbers.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return { count, medianMs: null, meanMs: null, minMs: null, maxMs: null };
  const middle = Math.floor(count / 2);
  const upper = sorted[middle]!;
  const medianMs = count % 2 ? upper : (sorted[middle - 1]! + upper) / 2;
  return {
    count, medianMs,
    meanMs: sorted.reduce((sum, value) => sum + value / count, 0),
    minMs: sorted[0]!, maxMs: sorted[count - 1]!,
  };
}

export type Transport = (request: SystemOneRequest) => Promise<SystemOneResult<Questions>>;

export type Attempt = {
  phase: "warmup" | "measured";
  iteration: number;
  latencyMs: number;
} & ({ ok: true; response: SystemOneResult<Questions> } | { ok: false; error: string });

export async function runBenchmark(
  options: Pick<Options, "warmups" | "iterations" | "timeoutMs">,
  transport: Transport,
  onError: (message: string) => void,
  now: () => number = () => performance.now(),
) {
  const startedAt = new Date().toISOString();
  const cases = [];
  for (const questions of [singleQuestions, batchQuestions]) {
    const questionCount = Object.keys(questions).length;
    const attempts: Attempt[] = [];
    for (const phase of ["warmup", "measured"] as const) {
      const count = phase === "warmup" ? options.warmups : options.iterations;
      for (let iteration = 1; iteration <= count; iteration++) {
        const start = now();
        let attempt: Attempt;
        try {
          const response = await transport({ model: "jev-latest", state: STATE, questions });
          attempt = { phase, iteration, latencyMs: now() - start, ok: true, response };
        } catch (error) {
          attempt = { phase, iteration, latencyMs: now() - start, ok: false, error: describeError(error) };
        }
        attempts.push(attempt);
        if (!attempt.ok) onError(`${questionCount} questions, ${phase} ${iteration}: ${attempt.error}`);
      }
    }
    const measured = attempts.filter(attempt => attempt.phase === "measured");
    cases.push({
      questionCount,
      statistics: statistics(measured.filter(attempt => attempt.ok).map(attempt => attempt.latencyMs)),
      measuredErrors: measured.filter(attempt => !attempt.ok).length,
      warmupErrors: attempts.filter(attempt => attempt.phase === "warmup" && !attempt.ok).length,
      attempts,
    });
  }
  return {
    schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
    model: "jev-latest", state: STATE,
    configuration: { ...options, retries: 0, concurrency: 1 },
    latencyDefinition: "Client-observed SDK call through parsed response, including network; milliseconds.",
    cases,
  };
}
