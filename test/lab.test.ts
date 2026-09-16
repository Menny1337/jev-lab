import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APIError, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { runBenchmark, statistics, type Transport } from "../src/benchmark.js";
import { createClient, describeError, safeJson } from "../src/client.js";
import { ConfigurationError, parseArgs, readApiKey } from "../src/config.js";
import { batchQuestions, singleQuestions, STATE } from "../src/questions.js";

const fixture: SystemOneResult<Questions> = {
  model: "mock-model",
  answers: { urgency: { type: "noul", noul: 0.5 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};

test("argument defaults, help and all valid options", () => {
  assert.equal(parseArgs([]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["batch", "-h"]).help, true);
  assert.deepEqual(parseArgs(["benchmark"]), {
    command: "benchmark", help: false, warmups: 1, iterations: 5, timeoutMs: 30_000,
  });
  assert.deepEqual(parseArgs(["benchmark", "--warmups", "0", "--iterations", "8", "--timeout-ms", "100"]), {
    command: "benchmark", help: false, warmups: 0, iterations: 8, timeoutMs: 100,
  });
});

test("invalid commands, flags, duplicates and numeric bounds fail without echoing values", () => {
  const invalid = [
    ["unknown"], ["smoke", "--api-key", "not-a-credential"], ["batch", "--warmups", "2"],
    ["benchmark", "--warmups"], ["benchmark", "--iterations", "0"],
    ["benchmark", "--warmups", "-1"], ["benchmark", "--iterations", "2.5"],
    ["benchmark", "--iterations", "1e2"], ["benchmark", "--timeout-ms", "Infinity"],
    ["benchmark", "--iterations", "10001"], ["benchmark", "--warmups", "1001"],
    ["smoke", "--timeout-ms", "300001"], ["smoke", "--timeout-ms", "0"],
    ["benchmark", "--warmups", "1", "--warmups", "2"],
    ["benchmark", "--iterations", "9007199254740992"],
    ["benchmark", "--iterations", " 2"], ["benchmark", "--iterations", ""],
  ];
  for (const args of invalid) assert.throws(() => parseArgs(args), ConfigurationError, args.join(" "));
});

test("key config rejects missing, blank and placeholder values", () => {
  for (const env of [{}, { TYPESAFE_API_KEY: "" }, { TYPESAFE_API_KEY: " " },
    { TYPESAFE_API_KEY: "your_api_key_here" }]) {
    assert.throws(() => readApiKey(env), /Set TYPESAFE_API_KEY/);
  }
  assert.equal(readApiKey({ TYPESAFE_API_KEY: " fixture-only " }), "fixture-only");
});

test("statistics handle odd, even, single and empty samples without mutation", () => {
  const values = [9, 1, 5];
  assert.deepEqual(statistics(values), { count: 3, medianMs: 5, meanMs: 5, minMs: 1, maxMs: 9 });
  assert.deepEqual(values, [9, 1, 5]);
  assert.equal(statistics([1, 7, 3, 5]).medianMs, 4);
  assert.deepEqual(statistics([2]), { count: 1, medianMs: 2, meanMs: 2, minMs: 2, maxMs: 2 });
  assert.deepEqual(statistics([]), { count: 0, medianMs: null, meanMs: null, minMs: null, maxMs: null });
  assert.equal(statistics([0]).minMs, 0);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => statistics([value]), RangeError);
});

test("benchmark runs sequentially and excludes warmups and failures from latency stats", async () => {
  let time = 0;
  let active = 0;
  let call = 0;
  const shapes: number[] = [];
  const errors: string[] = [];
  const durations = [100, 10, 20, 30, 200, 40, 50, 60];
  const transport: Transport = async request => {
    assert.equal(active++, 0, "requests must not overlap");
    assert.equal(request.state, STATE);
    assert.equal(request.model, "jev-latest");
    shapes.push(Object.keys(request.questions).length);
    time += durations[call++]!;
    await Promise.resolve();
    active--;
    if (call === 3) throw new Error("mock failure");
    return fixture;
  };
  const report = await runBenchmark({ warmups: 1, iterations: 3, timeoutMs: 1000 },
    transport, message => errors.push(message), () => time);
  assert.deepEqual(shapes, [1, 1, 1, 1, 3, 3, 3, 3]);
  assert.deepEqual(report.cases[0]?.statistics,
    { count: 2, medianMs: 20, meanMs: 20, minMs: 10, maxMs: 30 });
  assert.equal(report.cases[0]?.measuredErrors, 1);
  assert.equal(report.cases[1]?.statistics.medianMs, 50);
  assert.equal(report.cases[1]?.statistics.count, 3);
  assert.equal(report.cases[0]?.attempts[0]?.latencyMs, 100);
  assert.equal(report.cases[1]?.attempts[0]?.latencyMs, 200);
  assert.equal(report.cases[0]?.attempts[2]?.ok, false);
  assert.deepEqual(report.cases[0]?.attempts[1],
    { phase: "measured", iteration: 1, latencyMs: 10, ok: true, response: fixture });
  assert.equal(errors.length, 1);
});

test("benchmark records warmup errors and all-failed cases with null statistics", async () => {
  const errors: string[] = [];
  const report = await runBenchmark({ warmups: 1, iterations: 2, timeoutMs: 100 },
    async () => { throw new Error("mock failure"); }, message => errors.push(message));
  assert.equal(errors.length, 6);
  for (const result of report.cases) {
    assert.equal(result.warmupErrors, 1);
    assert.equal(result.measuredErrors, 2);
    assert.equal(result.statistics.count, 0);
    assert.equal(result.statistics.medianMs, null);
    assert.equal(result.attempts.length, 3);
  }
});

test("zero warmups makes only measured calls", async () => {
  let calls = 0;
  const report = await runBenchmark({ warmups: 0, iterations: 1, timeoutMs: 100 },
    async () => { calls++; return fixture; }, () => assert.fail("unexpected error"));
  assert.equal(calls, 2);
  assert.ok(report.cases.every(result => result.attempts.every(attempt => attempt.phase === "measured")));
});

test("official SDK serializes 1 and 3 question requests through an offline fetch", async () => {
  let calls = 0;
  const client = createClient("fixture-only", 100, async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture-only");
    assert.equal(typeof init.body, "string");
    const body: unknown = JSON.parse(String(init.body));
    assert.deepEqual(body, JSON.parse(JSON.stringify({
      model: "jev-latest", state: STATE, questions: calls++ === 0 ? singleQuestions : batchQuestions,
    })));
    return Response.json(fixture);
  });
  assert.equal(client.retry.maxRetries, 0);
  assert.equal(client.timeout, 100);
  assert.equal(client.logLevel, "off");
  for (const questions of [singleQuestions, batchQuestions]) {
    assert.deepEqual(await client.systemOne({ state: STATE, questions }), fixture);
  }
  assert.equal(calls, 2);
  assert.equal(batchQuestions.department.type, "choice");
  assert.equal(batchQuestions.frustration.type, "score");
});

test("HTTP failures are not retried and error bodies are not printed", async () => {
  let calls = 0;
  const client = createClient("fixture-only", 100, async () => {
    calls++;
    return Response.json({ error: "fixture-only" }, { status: 429 });
  });
  await assert.rejects(client.systemOne({ state: STATE, questions: singleQuestions }), error => {
    assert.ok(error instanceof APIError);
    assert.match(describeError(error), /HTTP 429/);
    assert.ok(!describeError(error).includes("fixture-only"));
    return true;
  });
  assert.equal(calls, 1);
  assert.ok(!describeError(new Error("fixture-only")).includes("fixture-only"));
});

test("JSON output redacts credential values, including escaped values", () => {
  assert.equal(safeJson({ value: "fixture-only" }, "fixture-only"),
    '{\n  "value": "[REDACTED]"\n}');
  assert.ok(!safeJson({ value: 'quote"and\\slash' }, 'quote"and\\slash').includes("quote"));
});

test("CLI help and missing-key errors work offline without reading a real .env", () => {
  // Run from the test folder, which has no .env; clear the inherited key for every subprocess.
  const run = (args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", "../src/cli.ts", ...args], {
      cwd: new URL(".", import.meta.url),
      env: { ...process.env, TYPESAFE_API_KEY: "" },
      encoding: "utf8",
      timeout: 10_000,
    });

  for (const args of [["--help"], ["smoke", "--help"], ["batch", "--help"], ["benchmark", "--help"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
  for (const command of ["smoke", "batch", "benchmark"]) {
    const result = run([command]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set TYPESAFE_API_KEY/);
  }
});

test("CLI saves raw benchmark reports and sets failure exit codes with offline fetch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-lab-test-"));
  try {
    for (const fail of ["", "yes"]) {
      const result = spawnSync(process.execPath, [
        "--import", import.meta.resolve("tsx"),
        "--import", new URL("./mock-fetch.ts", import.meta.url).href,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "benchmark", "--warmups", "0", "--iterations", "1",
      ], {
        cwd: directory,
        env: { ...process.env, TYPESAFE_API_KEY: "fixture-only", JEV_LAB_TEST_FAIL: fail },
        encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      assert.match(result.stdout, /Raw results:/);
      if (fail) assert.match(result.stderr, /HTTP 503/);
    }
    const files = await readdir(join(directory, "results"));
    assert.equal(files.length, 2);
    const reports: Awaited<ReturnType<typeof runBenchmark>>[] = await Promise.all(
      files.map(async file => JSON.parse(await readFile(join(directory, "results", file), "utf8"))),
    );
    const success = reports.find(report => report.cases[0]?.measuredErrors === 0);
    const failure = reports.find(report => report.cases[0]?.measuredErrors === 1);
    assert.ok(success);
    assert.ok(failure);
    assert.deepEqual(success.cases.map(result => result.questionCount), [1, 3]);
    for (const result of success.cases) {
      assert.equal(result.statistics.count, 1);
      const attempt = result.attempts[0];
      assert.ok(attempt?.ok);
      assert.equal(Object.keys(attempt.response.answers).length, result.questionCount);
      assert.equal(attempt.response.model, "mock-model");
    }
    for (const result of failure.cases) {
      assert.equal(result.statistics.count, 0);
      assert.equal(result.statistics.meanMs, null);
      assert.equal(result.measuredErrors, 1);
    }
    assert.ok(!JSON.stringify(reports).includes("fixture-only"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
