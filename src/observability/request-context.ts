import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const correlationStorage = new AsyncLocalStorage<string>();
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveCorrelationId(header: unknown): string {
  return typeof header === "string" && CORRELATION_ID_PATTERN.test(header) ? header : randomUUID();
}

export function runWithCorrelationId<T>(id: string, callback: () => T): T {
  return correlationStorage.run(id, callback);
}

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export function currentCorrelationHeader(): Record<string, string> {
  const id = currentCorrelationId();
  return id ? { "X-Correlation-ID": id } : {};
}
