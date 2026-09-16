import {
  APIConnectionError, APIError, APITimeoutError, TypeSafeClient,
  type Fetch,
} from "@typesafe-ai/sdk";
import { ConfigurationError } from "./config.js";

export function createClient(apiKey: string, timeout: number, fetch?: Fetch): TypeSafeClient {
  return new TypeSafeClient({
    apiKey,
    baseURL: "https://api.typesafe.ai",
    defaultModel: "jev-latest",
    timeout,
    retry: { maxRetries: 0 },
    logLevel: "off",
    ...(fetch ? { fetch } : {}),
  });
}

export function describeError(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof APIError) {
    return `TypeSafe API returned HTTP ${error.status}. Check credentials, quota and service status.`;
  }
  if (error instanceof APITimeoutError) return "TypeSafe request timed out.";
  if (error instanceof APIConnectionError) return "Could not connect to TypeSafe. Check network access.";
  // Do not print arbitrary exception bodies: upstream errors can contain credentials.
  return "Operation failed. Check API availability and local file permissions; no exception body was logged.";
}

export function safeJson(value: unknown, apiKey: string): string {
  const json = JSON.stringify(value, null, 2);
  const encodedKey = JSON.stringify(apiKey).slice(1, -1);
  return json.split(encodedKey).join("[REDACTED]");
}
