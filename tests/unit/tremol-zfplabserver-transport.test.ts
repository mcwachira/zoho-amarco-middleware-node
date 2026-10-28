import { describe, expect, it, vi } from "vitest";
import { TremolHttpTransport } from "../../src/infrastructure/device/tremol-zfplabserver-transport.js";

describe("TremolHttpTransport", () => {
  it("sends a bounded HTTP request and returns only the transport response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<Res Code="0"/>', {
        status: 200,
      }),
    );
    const transport = new TremolHttpTransport({ timeoutMs: 1_000, fetchImpl });

    await expect(transport.get(new URL("http://localhost:4444/ReadVersion()"))).resolves.toEqual({
      status: 200,
      body: '<Res Code="0"/>',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://localhost:4444/ReadVersion()"),
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    await transport.close();
  });

  it("classifies a request timeout as an unknown outcome and does not retry", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const transport = new TremolHttpTransport({ timeoutMs: 100, fetchImpl });
    const pending = transport.get(new URL("http://localhost:4444/ReadVersion()"));
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(await settled).toMatchObject({
      name: "TremolTransportError",
      kind: "outcome-unknown",
      reason: "timeout",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    await transport.close();
    vi.useRealTimers();
  });

  it("aborts in-flight work at shutdown and rejects subsequent requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const transport = new TremolHttpTransport({ timeoutMs: 1_000, fetchImpl });
    const pending = transport.get(new URL("http://localhost:4444/ReadVersion()"));
    await transport.close();

    await expect(pending).rejects.toMatchObject({
      name: "TremolTransportError",
      kind: "outcome-unknown",
      reason: "closed",
    });
    await expect(
      transport.get(new URL("http://localhost:4444/ReadVersion()")),
    ).rejects.toMatchObject({
      kind: "unavailable",
      reason: "closed",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
