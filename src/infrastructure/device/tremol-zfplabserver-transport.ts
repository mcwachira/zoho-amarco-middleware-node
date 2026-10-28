/**
 * Minimal HTTP transport for the vendor ZFP Lab Server interface.
 * The transport knows HTTP only; command names and XML belong to the client.
 */
export interface TremolTransportResponse {
  readonly status: number;
  readonly body: string;
}

export interface TremolTransport {
  get(url: URL): Promise<TremolTransportResponse>;
  close(): Promise<void>;
}

export type TremolTransportFailureKind = "unavailable" | "outcome-unknown";

/**
 * A transport failure is conservatively unknown because fetch cannot prove
 * whether a remote server received a request before a socket error/timeout.
 */
export class TremolTransportError extends Error {
  constructor(
    readonly kind: TremolTransportFailureKind,
    readonly reason: "closed" | "timeout" | "network_error",
  ) {
    super(`ZFPLabServer transport ${reason.replaceAll("_", " ")}.`);
    this.name = "TremolTransportError";
  }
}

export interface TremolHttpTransportOptions {
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

/** HTTP transport with bounded requests and abortable shutdown. */
export class TremolHttpTransport implements TremolTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(private readonly options: TremolHttpTransportOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 120_000
    ) {
      throw new Error("timeoutMs must be an integer between 100 and 120000 milliseconds.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(url: URL): Promise<TremolTransportResponse> {
    if (this.closed) throw new TremolTransportError("unavailable", "closed");

    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    let requestStarted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);

    try {
      requestStarted = true;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/xml, text/xml, text/plain", ...currentCorrelationHeader() },
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch {
      throw new TremolTransportError(
        timedOut || requestStarted ? "outcome-unknown" : "unavailable",
        timedOut ? "timeout" : this.closed ? "closed" : "network_error",
      );
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
import { currentCorrelationHeader } from "../../observability/request-context.js";
