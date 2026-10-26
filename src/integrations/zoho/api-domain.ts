/**
 * Validates API domains returned by Zoho Books.
 *
 * Exact hostname matching prevents untrusted HTTPS servers from receiving
 * Zoho access tokens.
 */
const ALLOWED_ZOHO_BOOKS_API_HOSTS = new Set([
  "www.zohoapis.com",
  "www.zohoapis.eu",
  "www.zohoapis.in",
  "www.zohoapis.com.au",
  "www.zohoapis.jp",
  "www.zohoapis.ca",
  "www.zohoapis.com.cn",
  "www.zohoapis.sa",
]);

/**
 * Returns a parsed URL only for a supported Zoho Books API origin.
 */
export function parseZohoBooksApiDomain(value: string): URL | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    !ALLOWED_ZOHO_BOOKS_API_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  return url;
}
