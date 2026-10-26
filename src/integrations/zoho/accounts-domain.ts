/**
 * Validates the configured Zoho Accounts origin.
 *
 * Exact hostname matching prevents OAuth credentials and tokens from being
 * sent to arbitrary HTTPS servers or lookalike domains.
 */
const ALLOWED_ZOHO_ACCOUNTS_HOSTS = new Set([
  "accounts.zoho.com",
  "accounts.zoho.eu",
  "accounts.zoho.in",
  "accounts.zoho.com.au",
  "accounts.zoho.jp",
  "accounts.zoho.com.cn",
  "accounts.zoho.sa",
  "accounts.zoho.uk",
  "accounts.zohocloud.ca",
]);

/**
 * Returns a parsed URL only for an approved Zoho Accounts origin.
 */
export function parseZohoAccountsDomain(value: string): URL | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    !ALLOWED_ZOHO_ACCOUNTS_HOSTS.has(url.hostname) ||
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
