import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import { runBenchmark } from "./benchmark.js";
import { createClient, describeError, safeJson } from "./client.js";
import { ConfigurationError, HELP, parseArgs, readApiKey } from "./config.js";
import { batchQuestions, singleQuestions, STATE } from "./questions.js";

function isMissingFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const loaded = config({ quiet: true });
  if (loaded.error && !isMissingFile(loaded.error)) {
    throw new ConfigurationError("Could not read the local .env file. Check its file permissions.");
  }
  const apiKey = readApiKey(process.env);
  const client = createClient(apiKey, options.timeoutMs);
  if (options.command !== "benchmark") {
    const response = await client.systemOne({
      model: "jev-latest", state: STATE,
      questions: options.command === "smoke" ? singleQuestions : batchQuestions,
    });
    console.log(safeJson(response, apiKey));
    return;
  }
  // Fail on directory access before making billable requests.
  await mkdir("results", { recursive: true });
  const filename = join("results", `benchmark-${randomUUID()}.json`);
  await writeFile(filename, "", { flag: "wx" });
  const report = await runBenchmark(options, async request => client.systemOne(request),
    message => console.error(message));
  await writeFile(filename, safeJson(report, apiKey) + "\n");
  console.table(report.cases.map(result => ({
    questions: result.questionCount,
    ...result.statistics,
    measuredErrors: result.measuredErrors,
    warmupErrors: result.warmupErrors,
  })));
  console.log(`Raw results: ${filename}`);
  if (report.cases.some(result => result.measuredErrors > 0 || result.warmupErrors > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
