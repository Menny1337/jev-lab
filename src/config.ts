export class ConfigurationError extends Error {}

export interface Options {
  command: "smoke" | "batch" | "benchmark";
  help: boolean;
  warmups: number;
  iterations: number;
  timeoutMs: number;
}

export const HELP = `Usage: npm start -- <smoke|batch|benchmark> [options]

Commands:
  smoke       Ask one urgency Noul question
  batch       Ask urgency, department and frustration in one request
  benchmark   Compare 1 and 3 questions, sequentially

Options:
  --warmups N       Warmups per benchmark case (default: 1, range: 0-1000)
  --iterations N    Measured attempts per case (default: 5, range: 1-10000)
  --timeout-ms N    Request timeout (default: 30000, range: 1-300000)
  -h, --help        Show help without loading credentials or calling the API

Benchmark results are written to .\\results. All requests use jev-latest.
Retries are disabled. API calls may incur charges.`;

export function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    command: "smoke", help: false, warmups: 1, iterations: 5, timeoutMs: 30_000,
  };
  if (args.length === 0) return { ...options, help: true };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ...options, help: true };
  }
  const command = args[0];
  if (command !== "smoke" && command !== "batch" && command !== "benchmark") {
    throw new ConfigurationError("Expected smoke, batch or benchmark. Use --help.");
  }
  options.command = command;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (flag !== "--warmups" && flag !== "--iterations" && flag !== "--timeout-ms") {
      throw new ConfigurationError("Unknown option. Use --help for supported options.");
    }
    if (seen.has(flag)) throw new ConfigurationError(`Duplicate option ${flag}.`);
    seen.add(flag);
    if (command !== "benchmark" && flag !== "--timeout-ms") {
      throw new ConfigurationError(`${flag} is only supported by benchmark.`);
    }
    const text = args[++i];
    const value = Number(text);
    const min = flag === "--warmups" ? 0 : 1;
    const max = flag === "--warmups" ? 1000 : flag === "--iterations" ? 10_000 : 300_000;
    if (text === undefined || !/^\d+$/.test(text) || !Number.isSafeInteger(value)
      || value < min || value > max) {
      throw new ConfigurationError(`${flag} requires an integer from ${min} to ${max}.`);
    }
    if (flag === "--warmups") options.warmups = value;
    else if (flag === "--iterations") options.iterations = value;
    else options.timeoutMs = value;
  }
  return options;
}

export function readApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key || key === "your_api_key_here") {
    throw new ConfigurationError(
      "Set TYPESAFE_API_KEY in your environment or local .env file. See README.md.",
    );
  }
  return key;
}
