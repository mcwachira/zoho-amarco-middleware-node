import { describe, expect, it } from "vitest";
import { parseZohoBooksApiDomain } from "../../src/integrations/zoho/api-domain.js";

describe("parseZohoBooksApiDomain", () => {
  it.each([
    "https://www.zohoapis.com",
    "https://www.zohoapis.eu",
    "https://www.zohoapis.in",
    "https://www.zohoapis.com.au",
    "https://www.zohoapis.jp",
    "https://www.zohoapis.ca",
    "https://www.zohoapis.com.cn",
    "https://www.zohoapis.sa",
  ])("accepts a supported Zoho Books API domain: %s", (domain) => {
    expect(parseZohoBooksApiDomain(domain)?.origin).toBe(domain);
  });

  it.each([
    "http://www.zohoapis.com",
    "https://attacker.example",
    "https://www.zohoapis.com.attacker.example",
    "https://www.zohoapis.com:8443",
    "https://user:password@www.zohoapis.com",
    "https://www.zohoapis.com/unexpected-path",
    "https://www.zohoapis.com/?unexpected=true",
    "https://www.zohoapis.com/#unexpected",
  ])("rejects an unsafe API domain: %s", (domain) => {
    expect(parseZohoBooksApiDomain(domain)).toBeNull();
  });
});
