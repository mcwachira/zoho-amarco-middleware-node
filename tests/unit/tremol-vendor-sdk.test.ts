import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const sdkDirectory = resolve(process.cwd(), "docs/JS/use_this_folder_only_for_nodejs");

class FakeElement {
  readonly firstChild: FakeElement | { readonly nodeValue: string } | null;

  constructor(
    readonly tagName: string,
    private readonly attributes: Readonly<Record<string, string>> = {},
    readonly children: readonly FakeElement[] = [],
    text = "",
  ) {
    this.firstChild = text === "" ? (children[0] ?? null) : { nodeValue: text };
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getElementsByTagName(tagName: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === tagName ? [child] : []),
      ...child.getElementsByTagName(tagName),
    ]);
  }
}

class FakeDocument {
  constructor(private readonly root: FakeElement) {}

  getElementsByTagName(tagName: string): FakeElement[] {
    return [
      ...(this.root.tagName === tagName ? [this.root] : []),
      ...this.root.getElementsByTagName(tagName),
    ];
  }
}

describe("supplied Tremol Node SDK source", () => {
  it("loads and runs read-only LabServer paths under Node using isolated fake dependencies", () => {
    const requests: Array<{
      method: string;
      url: string;
      body: unknown;
      async: boolean;
      headers: Readonly<Record<string, string>>;
      withCredentials: boolean;
    }> = [];
    class FakeXMLHttpRequest {
      withCredentials = true;
      status = 0;
      responseXML: FakeDocument | null = null;
      responseText = "";
      private requestMethod = "";
      private requestUrl = "";
      private requestAsync = true;
      private requestHeaders: Record<string, string> = {};

      overrideMimeType(mimeType: string): void {
        void mimeType;
      }
      setRequestHeader(name: string, value: string): void {
        this.requestHeaders[name] = value;
      }

      open(method: string, url: string, async: boolean): void {
        this.requestMethod = method;
        this.requestUrl = url;
        this.requestAsync = async;
        this.requestHeaders = {};
      }

      send(body: unknown): void {
        requests.push({
          method: this.requestMethod,
          url: this.requestUrl,
          body,
          async: this.requestAsync,
          headers: { ...this.requestHeaders },
          withCredentials: this.withCredentials,
        });
        this.status = 200;
        if (this.requestUrl.endsWith("/finddevice")) {
          this.responseXML = document(
            new FakeElement("Res", { Code: "0" }, [
              new FakeElement("com", {}, [], "COM_FAKE"),
              new FakeElement("baud", {}, [], "115200"),
            ]),
          );
        } else if (this.requestUrl.endsWith("/settings")) {
          this.responseXML = document(
            new FakeElement("Res", { Code: "0" }, [
              new FakeElement("tcp", {}, [], "0"),
              new FakeElement("com", {}, [], "COM_FAKE"),
              new FakeElement("baud", {}, [], "115200"),
              new FakeElement("ip", {}, [], "127.0.0.1"),
              new FakeElement("port", {}, [], "0"),
              new FakeElement("password", {}, [], "fake-server-secret"),
              new FakeElement("keepPortOpen", {}, [], "0"),
              new FakeElement("defVer", {}, [], "2509041522"),
            ]),
          );
        } else {
          this.responseXML = document(
            new FakeElement("Res", { Code: "0" }, [
              new FakeElement("Res", { Name: "Version", Value: "G03-test-fixture", Type: "Text" }),
            ]),
          );
        }
      }
    }

    class FakeDOMParser {
      parseFromString(source: string): FakeDocument {
        void source;
        throw new Error("Fake server always supplies responseXML directly.");
      }
    }

    const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
    const fakeRequire = (name: string): unknown => {
      if (name === "xmlhttprequest") return { XMLHttpRequest: FakeXMLHttpRequest };
      if (name === "xmldom") return { DOMParser: FakeDOMParser };
      if (name === "fs") {
        return {
          readFileSync: (path: string) => readFileSync(resolve(sdkDirectory, path), "utf8"),
        };
      }
      throw new Error(`Unexpected SDK dependency: ${name}`);
    };

    const loader = readFileSync(resolve(sdkDirectory, "nodejs_tremol_loader.js"), "utf8");
    runInNewContext(loader, { module: moduleObject, require: fakeRequire });
    const load = moduleObject.exports["load"];
    expect(typeof load).toBe("function");
    const tremol = (load as (paths: string[]) => Record<string, unknown>)(["fp_core.js", "fp.js"]);
    const FP = tremol["FP"] as new () => Record<string, (...args: unknown[]) => unknown>;
    const fp = new FP();
    const call = (name: string, ...args: unknown[]): unknown => {
      const method = fp[name];
      if (typeof method !== "function") throw new Error(`SDK method is unavailable: ${name}`);
      return method.apply(fp, args);
    };

    expect(call("GetVersionCore")).toBe("1.0.1.0");
    expect(call("GetVersionDefinitions")).toBe(2509041522);
    call("ServerSetSettings", "http://127.0.0.1:4444/");
    expect(call("ServerGetSettings")).toEqual({
      ipaddress: "http://127.0.0.1:4444/",
      tcpport: undefined,
    });
    expect(call("ServerFindDevice")).toEqual({
      serialPort: "COM_FAKE",
      baudRate: 115200,
      isWorkingOnTcp: false,
    });
    const deviceSettings = call("ServerGetDeviceSettings") as Record<string, unknown>;
    expect(deviceSettings["password"]).toBe("fake-server-secret");
    expect(call("IsCompatible")).toBe(true);
    expect(fp["PrintDiagnostics"]).toBeUndefined();
    expect(typeof fp["ReadDiagnostics"]).toBe("function");
    expect(call("ReadVersion")).toBe("G03-test-fixture");
    expect(call("IsWorking")).toBe(false);
    expect(requests).toEqual([
      {
        method: "GET",
        url: "http://127.0.0.1:4444/finddevice",
        body: null,
        async: false,
        headers: { "Content-Type": "text/plain" },
        withCredentials: false,
      },
      {
        method: "GET",
        url: "http://127.0.0.1:4444/settings",
        body: null,
        async: false,
        headers: { "Content-Type": "text/plain" },
        withCredentials: false,
      },
      {
        method: "POST",
        url: "http://127.0.0.1:4444/",
        body: '<Command Name="ReadVersion"></Command>',
        async: false,
        headers: { "Content-Type": "text/plain" },
        withCredentials: false,
      },
    ]);
  });
});

function document(root: FakeElement): FakeDocument {
  return new FakeDocument(root);
}
