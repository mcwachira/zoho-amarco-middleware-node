import { describe, expect, it, vi } from "vitest";
import { TremolDeviceDiagnostics } from "../../src/infrastructure/device/tremol-device-diagnostics.js";
import { TremolZfpLabServerClient } from "../../src/infrastructure/device/tremol-zfplabserver-client.js";

function createClient(
  responseBody = '<Res Code="0"><Res Name="Version" Value="G03.1" Type="Text"/></Res>',
  status = 200,
) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody, { status }));

  const client = new TremolZfpLabServerClient({
    baseUrl: "http://localhost:4444",
    fetchImpl,
  });

  return { client, fetchImpl };
}

describe("TremolDeviceDiagnostics", () => {
  it("reports connected when the read-only version command succeeds", async () => {
    const { client, fetchImpl } = createClient();
    const diagnostics = new TremolDeviceDiagnostics(client);

    await expect(diagnostics.checkConnection()).resolves.toEqual({
      status: "connected",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://localhost:4444/ReadVersion()");
  });

  it("reports unavailable when the HTTP service returns an error", async () => {
    const { client } = createClient("service unavailable", 503);
    const diagnostics = new TremolDeviceDiagnostics(client);

    await expect(diagnostics.checkConnection()).resolves.toEqual({
      status: "unavailable",
      reason: "TremolHttpError",
    });
  });

  it("reports unavailable when the response is invalid XML", async () => {
    const { client } = createClient("not XML");
    const diagnostics = new TremolDeviceDiagnostics(client);

    await expect(diagnostics.checkConnection()).resolves.toEqual({
      status: "unavailable",
      reason: "TremolProtocolError",
    });
  });

  it("reports unavailable when the device command returns an error", async () => {
    const { client } = createClient('<Res Code="40"><Err Type="FPException"/></Res>');
    const diagnostics = new TremolDeviceDiagnostics(client);

    await expect(diagnostics.checkConnection()).resolves.toEqual({
      status: "unavailable",
      reason: "TremolDeviceError",
    });
  });

  it("does not expose raw response bodies or connection URLs", async () => {
    const sensitiveBody = "internal response details";
    const { client } = createClient(sensitiveBody, 503);
    const diagnostics = new TremolDeviceDiagnostics(client);

    const result = await diagnostics.checkConnection();

    expect(JSON.stringify(result)).not.toContain(sensitiveBody);
    expect(JSON.stringify(result)).not.toContain("localhost");
  });

  it("handles unexpected non-Error exceptions", async () => {
    const { client } = createClient();
    const readVersion = vi.spyOn(client, "readVersion").mockRejectedValue("unexpected failure");

    const diagnostics = new TremolDeviceDiagnostics(client);

    await expect(diagnostics.checkConnection()).resolves.toEqual({
      status: "unavailable",
      reason: "UnknownDeviceConnectionError",
    });

    expect(readVersion).toHaveBeenCalledOnce();
  });
});
