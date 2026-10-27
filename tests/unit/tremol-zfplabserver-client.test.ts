import { describe, expect, it, vi } from "vitest";
import {
  TremolDeviceError,
  TremolHttpError,
  TremolProtocolError,
  TremolZfpLabServerClient,
  parseTremolCloseReceiptMetadata,
  parseTremolStatusFlags,
  parseTremolVersion,
} from "../../src/infrastructure/device/tremol-zfplabserver-client.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

  it("accepts the XML response shape expected by the local parser", async () => {
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

  it("parses the documented ReadVersion result field", async () => {
    const body = '<Res Code="0"><Res Name="Version" Value="G03.1" Type="Text"/></Res>';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    await expect(client.readVersion()).resolves.toMatchObject({
      version: "G03.1",
      response: { resultCode: 0, body },
    });
  });

  it("rejects missing, duplicate, or invalid ReadVersion values", () => {
    expect(() => parseTremolVersion('<Res Code="0"></Res>')).toThrow(TremolProtocolError);
    expect(() =>
      parseTremolVersion(
        '<Res Code="0"><Res Name="Version" Value="1"/><Res Name="Version" Value="2"/></Res>',
      ),
    ).toThrow(TremolProtocolError);
    expect(() => parseTremolVersion('<Res Code="0"><Res Name="Version" Value=""/></Res>')).toThrow(
      TremolProtocolError,
    );
    expect(() =>
      parseTremolVersion(`<Res Code="0"><Res Name="Version" Value="${"x".repeat(31)}"/></Res>`),
    ).toThrow(TremolProtocolError);
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

  it("rejects a response without the XML result envelope expected by the parser", async () => {
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

  it("keeps ReadStatus flags and readiness unknown without a documented XML mapping", async () => {
    const body =
      '<Res Code="0">' +
      '<Res Name="ST0" Value="218" Type="Decimal"/>' +
      '<Res Name="ST1" Value="130" Type="Decimal"/>' +
      '<Res Name="ST2" Value="230" Type="Decimal"/>' +
      '<Res Name="ST3" Value="224" Type="Decimal"/>' +
      '<Res Name="ST4" Value="135" Type="Decimal"/>' +
      '<Res Name="ST5" Value="255" Type="Decimal"/>' +
      '<Res Name="Power_down_in_opened_fiscal_receipt" Value="true" Type="Boolean"/>' +
      "</Res>";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const client = new TremolZfpLabServerClient({
      baseUrl: "http://localhost:4444",
      fetchImpl,
    });

    const result = await client.readStatus();

    expect(result.response.status).toBe(200);
    expect(result.flags).toMatchObject({
      readiness: "unknown",
      powerDownInOpenedFiscalReceipt: null,
      dateTimeNotSet: null,
      dateTimeWrong: null,
      ramReset: null,
      hardwareClockError: null,
      registersOverflow: null,
      fiscalReceiptOpened: null,
      receiptInvoiceType: null,
      sdCardNearFull: null,
      sdCardFull: null,
      cuFiscalized: null,
      cuProduced: null,
      pairedWithTims: null,
      unsentReceipts: null,
      serviceContractNearlyExpired: null,
      noSecurityIc: null,
      noCertificates: null,
      serviceJumper: null,
      expiredServiceContract: null,
      missingSdCard: null,
      wrongSdCard: null,
      updateAvailable: null,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://localhost:4444/ReadStatus()");
  });

  it("keeps status values unknown when the server omits its unverified mapping", () => {
    const flags = parseTremolStatusFlags('<Res Code="0"></Res>');

    expect(flags.readiness).toBe("unknown");
    expect(flags.fiscalReceiptOpened).toBeNull();
    expect(flags.dateTimeNotSet).toBeNull();
  });

  it("rejects malformed or failed ReadStatus envelopes", () => {
    expect(() => parseTremolStatusFlags("<Res")).toThrow(TremolProtocolError);
    expect(() =>
      parseTremolStatusFlags('<Res Code="40"><Err Type="FPException" STE1="30" STE2="34"/></Res>'),
    ).toThrow(TremolDeviceError);
  });

  it("parses documented close metadata from a synthetic generic XML response", async () => {
    const fixtureUrl = new URL("../fixtures/tremol-close-receipt-response.xml", import.meta.url);
    const body = await readFile(fileURLToPath(fixtureUrl), "utf8");

    expect(parseTremolCloseReceiptMetadata(body)).toEqual({
      invoiceNumber: "CU202500000000001",
      qrCode: "SYNTHETIC-QR-PAYLOAD",
    });
  });

  it.each([
    ["malformed XML", "<Res"],
    ["missing the invoice number", '<Res Code="0"><Res Name="QRcode" Value="qr"/></Res>'],
    ["missing the QR value", '<Res Code="0"><Res Name="InvoiceNum" Value="1"/></Res>'],
    [
      "duplicate invoice numbers",
      '<Res Code="0"><Res Name="InvoiceNum" Value="1"/><Res Name="InvoiceNum" Value="2"/><Res Name="QRcode" Value="qr"/></Res>',
    ],
    [
      "an empty invoice number",
      '<Res Code="0"><Res Name="InvoiceNum" Value=""/><Res Name="QRcode" Value="qr"/></Res>',
    ],
    [
      "an overlong invoice number",
      `<Res Code="0"><Res Name="InvoiceNum" Value="${"1".repeat(20)}"/><Res Name="QRcode" Value="qr"/></Res>`,
    ],
    [
      "an overlong QR value",
      `<Res Code="0"><Res Name="InvoiceNum" Value="1"/><Res Name="QRcode" Value="${"q".repeat(129)}"/></Res>`,
    ],
  ])("rejects close metadata when response is %s", (_description, body) => {
    expect(() => parseTremolCloseReceiptMetadata(body)).toThrow(TremolProtocolError);
  });

  it("distinguishes device error responses while parsing close metadata", () => {
    expect(() =>
      parseTremolCloseReceiptMetadata('<Res Code="40"><Err Type="FPException"/></Res>'),
    ).toThrow(TremolDeviceError);
  });
});
