import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KraOscuClient, KRA_OSCU_BASE_URLS } from "../../src/integrations/etims/kra-oscu-client.js";
import { KraVscuClient } from "../../src/integrations/etims/kra-vscu-client.js";
import { kraOscuReferenceRequestSchema } from "../../src/integrations/etims/kra-reference-schemas.js";
import {
  kraDecimalToNumber,
  KraRequestError,
} from "../../src/integrations/etims/kra-protocol-client.js";
import { syntheticMappedRequest } from "./kra-sales-mapping-fixture.js";

const servers: Server[] = [];

function validOscuSalesRequest() {
  return syntheticMappedRequest("oscu");
}

function validVscuSalesRequest() {
  return syntheticMappedRequest("vscu");
}

async function localService(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture did not bind TCP.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("KRA protocol clients", () => {
  it("keeps the OSCU environment pinned to the official distinct KRA origins", () => {
    const sandboxFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ resultCd: "000", resultMsg: "ok", resultDt: "20260401010101", data: {} }),
      );
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl: sandboxFetch });
    expect(KRA_OSCU_BASE_URLS.sandbox).toContain("etims-api-sbx.kra.go.ke");
    expect(KRA_OSCU_BASE_URLS.production).toContain("etims-api.kra.go.ke");
    expect(client.getReadiness()).toMatchObject({
      environment: "sandbox",
      contractVerified: false,
      liveOperationPermitted: false,
      reconciliationVerified: false,
    });
  });

  it("serializes the official OSCU initialization request and validates its response envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        resultCd: "000",
        resultMsg: "ok",
        resultDt: "20260401010101",
        data: { cmcKey: "synthetic-key" },
      }),
    );
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    const result = await client.initialize({
      tin: "A123456789Z",
      bhfId: "00",
      dvcSrlNo: "SYNTHETIC",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${KRA_OSCU_BASE_URLS.sandbox}selectInitOsdcInfo`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      tin: "A123456789Z",
      bhfId: "00",
      dvcSrlNo: "SYNTHETIC",
    });
    expect(result).toMatchObject({ kind: "accepted", response: { resultCd: "000" } });
  });

  it("uses VSCU's own initialization and reference-data paths over real local HTTP", async () => {
    const seen: Array<{ path: string; body: unknown; method: string | undefined }> = [];
    const baseUrl = await localService((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        seen.push({
          path: request.url ?? "",
          body: JSON.parse(body) as unknown,
          method: request.method,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            resultCd: "000",
            resultMsg: "ok",
            resultDt: "20260401010101",
            data: { clsList: [] },
          }),
        );
      });
    });
    const client = new KraVscuClient({ baseUrl });
    await client.initialize({ tin: "A123456789Z", bhfId: "00", dvcSrlNo: "SYNTHETIC" });
    await client.getCodes({ tin: "A123456789Z", bhfId: "00", lastReqDt: "20260401000000" });
    expect(seen).toEqual([
      {
        path: "/initializer/selectInitInfo",
        body: { tin: "A123456789Z", bhfId: "00", dvcSrlNo: "SYNTHETIC" },
        method: "POST",
      },
      {
        path: "/code/selectCodes",
        body: { tin: "A123456789Z", bhfId: "00", lastReqDt: "20260401000000" },
        method: "POST",
      },
    ]);
    expect(client.getReadiness()).toMatchObject({
      mode: "vscu",
      contractVerified: false,
      liveOperationPermitted: false,
    });
  });

  it("classifies a well-formed KRA rejection without converting it to success", async () => {
    const client = new KraOscuClient({
      environment: "sandbox",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ resultCd: "994", resultMsg: "synthetic rejection" })),
    });
    await expect(
      client.getCodes({
        tin: "A123456789Z",
        bhfId: "00",
        cmcKey: "synthetic-key",
        lastReqDt: "20260401000000",
      }),
    ).resolves.toMatchObject({ kind: "rejected", resultCode: "994" });
  });

  it("does not retry a sales write and classifies a lost response as uncertain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("socket closed"));
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    const request = validOscuSalesRequest();
    await expect(client.saveSales(request)).rejects.toMatchObject({
      name: "KraRequestError",
      category: "transport",
      outcomeMayBeUnknown: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects invalid initialization and sales request data before transmission", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    expect(() => client.initialize({ tin: "bad", bhfId: "00", dvcSrlNo: "x" })).toThrow();
    await expect(client.saveSales({ tin: "A123456789Z" })).rejects.toThrow(
      "Invalid OSCU sales request",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a structurally valid but unmapped OSCU request before transmission", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    await expect(client.saveSales({ ...validOscuSalesRequest() })).rejects.toMatchObject({
      category: "configuration",
      outcomeMayBeUnknown: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("converts immutable decimal strings to cent-precision JSON numbers safely", () => {
    expect(kraDecimalToNumber("123456.70")).toBe(123456.7);
    expect(() => kraDecimalToNumber("1.001")).toThrow("at most two fractional digits");
    expect(() => kraDecimalToNumber("90071992547409.92")).toThrow("safe cent-precision range");
  });

  it("validates documented OSCU sales fields and types successful response data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        resultCd: "000",
        resultMsg: "synthetic success",
        resultDt: "20260401010101",
        data: {
          curRcptNo: 1,
          totRcptNo: 1,
          intrlData: "SYNTHETIC",
          rcptSign: "SYNTHETIC",
          sdcDateTime: "20260401010101",
        },
      }),
    );
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    const outcome = await client.saveSales(validOscuSalesRequest());
    expect(outcome).toMatchObject({ kind: "accepted", response: { data: { curRcptNo: 1 } } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toHaveProperty(
      "itemList[0].itemCd",
      "SYNITEM",
    );
  });

  it("marks malformed successful sales responses as uncertain after transmission", async () => {
    const client = new KraOscuClient({
      environment: "sandbox",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ resultCd: "000", resultMsg: "ok", data: {} })),
    });
    await expect(client.saveSales(validOscuSalesRequest())).rejects.toMatchObject({
      category: "malformed_response",
      outcomeMayBeUnknown: true,
    });
  });

  it("uses the VSCU sales shape and validates its documented response example", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        resultCd: "000",
        resultMsg: "synthetic success",
        resultDt: "20260401010101",
        data: {
          rcptNo: 1,
          intrlData: "SYNTHETIC",
          rcptSign: "SYNTHETIC",
          totRcptNo: 1,
          VSCURcptPbctDate: "20260401010101",
          sdcId: "SYNTHETIC-CU",
          mrcNo: "SYNTHETIC-MRC",
        },
      }),
    );
    const client = new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl });
    const outcome = await client.saveSales(validVscuSalesRequest());
    expect(outcome).toMatchObject({ kind: "accepted", response: { data: { rcptNo: 1 } } });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8088/trnsSales/saveSales");
  });

  it("rejects impossible dates before an OSCU sales request is sent", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    await expect(
      client.saveSales({ ...validOscuSalesRequest(), cfmDt: "20260230010101" }),
    ).rejects.toMatchObject({
      category: "configuration",
      outcomeMayBeUnknown: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports malformed responses after writes as uncertain and never exposes response bodies", async () => {
    const client = new KraVscuClient({
      baseUrl: "http://127.0.0.1:8088",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("taxpayer-secret-body", { status: 200 })),
    });
    const error = await client
      .getCodes({ tin: "A123456789Z", bhfId: "00", lastReqDt: "20260401000000" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KraRequestError);
    expect((error as Error).message).not.toContain("taxpayer-secret-body");
  });

  it("marks a timed-out VSCU reference read as safe to repeat after transmission", async () => {
    let received = false;
    const baseUrl = await localService((request) => {
      received = request.method === "POST" && request.url === "/code/selectCodes";
      // Deliberately hold the response open so the client deadline expires.
    });
    const client = new KraVscuClient({ baseUrl, timeoutMs: 2000 });
    await expect(
      client.getCodes({ tin: "A123456789Z", bhfId: "00", lastReqDt: "20260401000000" }),
    ).rejects.toMatchObject({ category: "timeout", outcomeMayBeUnknown: false });
    expect(received).toBe(true);
  });

  it("does not send a request when cancellation is already signalled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.getCodes(
        { tin: "A123456789Z", bhfId: "00", lastReqDt: "20260401000000" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ category: "cancelled_before_send", outcomeMayBeUnknown: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates typed reference response data and rejects malformed records", async () => {
    const validClient = new KraVscuClient({
      baseUrl: "http://127.0.0.1:8088",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          resultCd: "000",
          resultMsg: "synthetic fixture",
          resultDt: "20260401010101",
          data: {
            itemList: [
              {
                itemCd: "SYN-1",
                itemClsCd: "1110160600",
                itemTyCd: "2",
                itemNm: "Synthetic item",
                dftPrc: 1.25,
                internalUnmodeledValue: "discarded",
              },
            ],
          },
        }),
      ),
    });
    const accepted = await validClient.getItems({
      tin: "A123456789Z",
      bhfId: "00",
      lastReqDt: "20260401000000",
    });
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind === "accepted") {
      expect(accepted.response.data.itemList?.[0]).toMatchObject({
        itemCd: "SYN-1",
        dftPrc: 1.25,
      });
      expect(accepted.response.data.itemList?.[0]).not.toHaveProperty("internalUnmodeledValue");
    }

    const invalidClient = new KraVscuClient({
      baseUrl: "http://127.0.0.1:8088",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          resultCd: "000",
          resultMsg: "synthetic fixture",
          resultDt: "20260401010101",
          data: { itemList: [{ itemCd: 123 }] },
        }),
      ),
    });
    await expect(
      invalidClient.getItems({ tin: "A123456789Z", bhfId: "00", lastReqDt: "20260401000000" }),
    ).rejects.toMatchObject({ category: "malformed_response", outcomeMayBeUnknown: false });
  });

  it("requires table-defined OSCU cmcKey and valid reference timestamps before network access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new KraOscuClient({ environment: "sandbox", fetchImpl });
    await expect(
      client.getCodes({
        tin: "A123456789Z",
        bhfId: "00",
        cmcKey: "synthetic-key",
        lastReqDt: "20260230000000",
      }),
    ).rejects.toThrow();
    expect(
      kraOscuReferenceRequestSchema.safeParse({
        tin: "A123456789Z",
        bhfId: "00",
        cmcKey: "synthetic-key",
        lastReqDt: "20260401000000",
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
