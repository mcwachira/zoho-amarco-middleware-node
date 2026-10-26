import { describe, expect, it, vi } from "vitest";
import {
  TremolDeviceError,
  TremolHttpError,
  TremolProtocolError,
  TremolZfpLabServerClient,
} from "../../src/infrastructure/device/tremol-zfplabserver-client.js";

describe("TremolZfpLabServerClient", () => {


  it("rejects a URL that does not use HTTP or HTTPS", () => {
    expect(
        () =>
            new TremolZfpLabServerClient({
              baseUrl: "ftp://localhost:4444",
            }),
    ).toThrow("A valid HTTP(S) ZFPLabServer URL is required.");
  });

  it("rejects URLs containing credentials", () => {
    expect(
        () =>
            new TremolZfpLabServerClient({
              baseUrl: "http://user:password@localhost:4444",
            }),
    ).toThrow("A valid HTTP(S) ZFPLabServer URL is required.");
  });

  it("rejects a zero or negative timeout", () => {
    for (const timeoutMs of [0, -1]) {
      expect(
          () =>
              new TremolZfpLabServerClient({
                baseUrl: "http://localhost:4444",
                timeoutMs,
              }),
      ).toThrow("timeoutMs must be a positive integer.");
    }
  });

  it("sends a read command to ZFPLabServer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<Res Code="0"></Res>', { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    const result = await client.executeRead("ReadStatus()");

    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, options] = fetchImpl.mock.calls[0]!;

    expect(String(url)).toBe("http://localhost:4444/ReadStatus()");
    expect(options?.method).toBe("GET");
    expect(result).toEqual({
      status: 200,
      resultCode: 0,
      body: '<Res Code="0"></Res>',
    });
  });

  it("rejects non-successful HTTP responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("server unavailable", { status: 503 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    await expect(client.executeRead("ReadVersion()")).rejects.toBeInstanceOf(TremolHttpError);
  });

  it("preserves HTTP error status and response body", async () => {
    const responseBody = "ZFPLabServer unavailable";

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(responseBody, { status: 503 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    await expect(client.executeRead("ReadStatus()")).rejects.toMatchObject({
      name: "TremolHttpError",
      status: 503,
      responseBody,
    });
  });

  it("accepts a documented successful XML response", async () => {
    const responseBody = '<Res Code="0"><Res Name="Example" Value="123" Type="String"/></Res>';

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(responseBody, { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    const result = await client.executeRead("ReadStatus()");

    expect(result.status).toBe(200);
    expect(result.resultCode).toBe(0);
    expect(result.body).toBe(responseBody);
  });

  it("rejects a nonzero Tremol result code even when HTTP succeeds", async () => {
    const errorXml =
      '<Res Code="40"><Err Type="FPException" STE1="30" STE2="34">' +
      "<Message>Command error</Message></Err></Res>";

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(errorXml, { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    await expect(client.executeRead("ReadStatus()")).rejects.toMatchObject({
      name: "TremolDeviceError",
      resultCode: 40,
      responseBody: errorXml,
    });
  });

  it("preserves the complete XML diagnostics for device errors", async () => {
    const errorXml =
      '<Res Code="40">' +
      '<Err Type="FPException" STE1="30" STE2="34" FPLibErrorCode="04">' +
      "<Message>Command syntax error</Message>" +
      "</Err></Res>";

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(errorXml, { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    try {
      await client.executeRead("ReadStatus()");
      throw new Error("Expected the device command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(TremolDeviceError);
      expect(error).toMatchObject({
        resultCode: 40,
        responseBody: errorXml,
      });
    }
  });

  it("rejects a response without the documented result envelope", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not XML", { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    await expect(client.executeRead("ReadStatus()")).rejects.toBeInstanceOf(TremolProtocolError);
  });

  it.each([
    ["mismatched XML tags", '<Res Code="0"><Item></Res>'],
    ["content after the root element", '<Res Code="0"></Res><Extra/>'],
    ["a missing Code attribute", "<Res></Res>"],
    ["a nonnumeric Code attribute", '<Res Code="success"></Res>'],
    ["an unexpected root element", '<Response Code="0"></Response>'],
  ])("rejects XML containing %s", async (_description, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    await expect(client.executeRead("ReadStatus()")).rejects.toBeInstanceOf(TremolProtocolError);
  });

  it("does not start the next command until the first request finishes", async () => {
    let releaseFirstRequest!: (response: Response) => void;
    let notifyFirstStarted!: () => void;

    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirstRequest = resolve;
    });

    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        notifyFirstStarted();
        return firstResponse;
      })
      .mockResolvedValueOnce(new Response('<Res Code="0"></Res>', { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    const first = client.executeRead("ReadStatus()");
    const second = client.executeRead("ReadVersion()");

    await firstStarted;

    expect(fetchImpl).toHaveBeenCalledOnce();

    releaseFirstRequest(new Response('<Res Code="0"></Res>', { status: 200 }));

    await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("recovers the command queue after a request times out", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) {
            reject(new Error("Expected an abort signal."));
            return;
          }

          const rejectOnAbort = () => {
            reject(signal.reason);
          };

          if (signal.aborted) {
            rejectOnAbort();
            return;
          }

          signal.addEventListener("abort", rejectOnAbort, {
            once: true,
          });
        });
      })
      .mockResolvedValueOnce(new Response('<Res Code="0"></Res>', { status: 200 }));

    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      timeoutMs: 20,
      fetchImpl,
    });

    await expect(client.executeRead("ReadStatus()")).rejects.toMatchObject({
      name: "TimeoutError",
    });

    const result = await client.executeRead("ReadVersion()");

    expect(result.resultCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
