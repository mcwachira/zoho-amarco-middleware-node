import { Router } from "express";

import type { ZohoOAuthService } from "../application/zoho/zoho-oauth-service.js";

/**
 * Creates the HTTP routes for the initial Zoho OAuth flow.
 *
 * The service is injected so these routes can be tested without a real
 * database or Zoho account. When OAuth is not configured, the routes
 * remain available but report that the feature is unavailable.
 */
export function createZohoOAuthRouter(oauthService: ZohoOAuthService | undefined): Router {
  const router = Router();

  router.get("/authorize", async (_req, res) => {
    if (!oauthService) {
      res.status(503).json({
        error: {
          code: "ZOHO_OAUTH_UNAVAILABLE",
          message: "Zoho OAuth is not configured.",
        },
      });
      return;
    }

    const { authorizationUrl } = await oauthService.startAuthorization();

    // The state and encrypted PKCE verifier have been persisted before
    // the browser is redirected to Zoho.
    res.redirect(302, authorizationUrl);
  });

  router.get("/callback", async (req, res) => {
    if (!oauthService) {
      res.status(503).json({
        error: {
          code: "ZOHO_OAUTH_UNAVAILABLE",
          message: "Zoho OAuth is not configured.",
        },
      });
      return;
    }

    const state = typeof req.query["state"] === "string" ? req.query["state"] : "";

    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";

    const providerError = typeof req.query["error"] === "string" ? req.query["error"] : "";

    // Consume state before processing the result so the callback cannot
    // be replayed, including when the user denies authorization.
    const attempt = await oauthService.consumeCallbackState(state);

    if (!attempt) {
      res.status(400).json({
        error: {
          code: "INVALID_OAUTH_STATE",
          message: "The OAuth state is missing, expired, or invalid.",
        },
      });
      return;
    }

    if (providerError) {
      res.status(400).json({
        error: {
          code: "ZOHO_AUTHORIZATION_DENIED",
          message: "Zoho authorization was not completed.",
        },
      });
      return;
    }

    if (!code) {
      res.status(400).json({
        error: {
          code: "INVALID_OAUTH_CALLBACK",
          message: "The OAuth callback did not include an authorization code.",
        },
      });
      return;
    }

    // Exchange the authorization code using the PKCE verifier recovered
    // from the successfully consumed, one-time OAuth state.
    await oauthService.exchangeAuthorizationCode(code, attempt.codeVerifier);

    // Never include access or refresh tokens in the HTTP response.
    res.status(200).json({
      message: "Zoho OAuth authorization completed successfully.",
    });
  });

  return router;
}
