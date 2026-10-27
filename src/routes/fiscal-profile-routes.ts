import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { FiscalCustomerProfileRepository } from "../application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "../application/fiscalization/fiscal-item-profile-repository.js";
import {
  DuplicateFiscalProfileError,
  FiscalProfileNotFoundError,
  InvalidFiscalProfileError,
} from "../application/fiscalization/fiscal-profile-errors.js";

const customerProfileSchema = z
  .object({
    zohoCustomerId: z.string(),
    companyName: z.string(),
    clientPin: z.string(),
    headquarters: z.string(),
    address: z.string(),
    postalCodeAndCity: z.string(),
    exemptionNumber: z.string().nullable(),
  })
  .strict();

const customerProfileDataSchema = customerProfileSchema.omit({ zohoCustomerId: true });

const itemProfileSchema = z
  .object({
    zohoItemId: z.string(),
    measureUnit: z.string(),
    hsCode: z.string(),
    hsName: z.string(),
    vatClass: z.string(),
    vatGroupRate: z.string(),
  })
  .strict();

const itemProfileDataSchema = itemProfileSchema.omit({ zohoItemId: true });

export interface FiscalProfileRouteDependencies {
  readonly customerRepository?: FiscalCustomerProfileRepository;
  readonly itemRepository?: FiscalItemProfileRepository;
}

function invalidBody(res: Response, details: string[]): void {
  res.status(400).json({
    error: {
      code: "INVALID_PROFILE_REQUEST",
      message: "The request body does not match the expected profile fields.",
      details,
    },
  });
}

function handleProfileError(req: Request, res: Response, error: unknown): void {
  if (error instanceof InvalidFiscalProfileError) {
    res.status(400).json({
      error: {
        code: "INVALID_FISCAL_PROFILE",
        message: error.message,
        field: error.field,
      },
    });
    return;
  }

  if (error instanceof FiscalProfileNotFoundError) {
    res.status(404).json({
      error: {
        code: "FISCAL_PROFILE_NOT_FOUND",
        message: "The fiscal profile was not found.",
      },
    });
    return;
  }

  if (error instanceof DuplicateFiscalProfileError) {
    res.status(409).json({
      error: {
        code: "FISCAL_PROFILE_ALREADY_EXISTS",
        message: "A fiscal profile already exists for this Zoho identity.",
      },
    });
    return;
  }

  req.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Fiscal profile operation failed",
  );
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    },
  });
}

export function createFiscalProfileRouter(dependencies: FiscalProfileRouteDependencies): Router {
  const router = Router();

  router.post("/fiscal-customer-profiles", async (req, res) => {
    if (!dependencies.customerRepository) {
      res.status(503).json({
        error: {
          code: "FISCAL_PROFILE_REPOSITORY_UNAVAILABLE",
          message: "Fiscal customer profile management is not configured.",
        },
      });
      return;
    }

    const body: unknown = req.body;
    const parsed = customerProfileSchema.safeParse(body);
    if (!parsed.success) {
      invalidBody(
        res,
        parsed.error.issues.map((issue) => issue.path.join(".") || "body"),
      );
      return;
    }

    try {
      const profile = await dependencies.customerRepository.create(parsed.data);
      res
        .location(
          `/integrations/zoho/fiscal-customer-profiles/${encodeURIComponent(profile.zohoCustomerId)}`,
        )
        .status(201)
        .json({ profile });
    } catch (error: unknown) {
      handleProfileError(req, res, error);
    }
  });

  router.get("/fiscal-customer-profiles/:zohoCustomerId", async (req, res) => {
    if (!dependencies.customerRepository) {
      res.status(503).json({
        error: {
          code: "FISCAL_PROFILE_REPOSITORY_UNAVAILABLE",
          message: "Fiscal customer profile management is not configured.",
        },
      });
      return;
    }

    const zohoCustomerId =
      typeof req.params["zohoCustomerId"] === "string" ? req.params["zohoCustomerId"] : "";

    try {
      const profile = await dependencies.customerRepository.findByZohoCustomerId(zohoCustomerId);
      if (!profile) {
        res.status(404).json({
          error: {
            code: "FISCAL_PROFILE_NOT_FOUND",
            message: "The fiscal profile was not found.",
          },
        });
        return;
      }

      res.status(200).json({ profile });
    } catch (error: unknown) {
      handleProfileError(req, res, error);
    }
  });

  router.put("/fiscal-customer-profiles/:zohoCustomerId", async (req, res) => {
    if (!dependencies.customerRepository) {
      res.status(503).json({
        error: {
          code: "FISCAL_PROFILE_REPOSITORY_UNAVAILABLE",
          message: "Fiscal customer profile management is not configured.",
        },
      });
      return;
    }

    const zohoCustomerId =
      typeof req.params["zohoCustomerId"] === "string" ? req.params["zohoCustomerId"] : "";
    const body: unknown = req.body;
    const parsed = customerProfileDataSchema.safeParse(body);
    if (!parsed.success) {
      invalidBody(
        res,
        parsed.error.issues.map((issue) => issue.path.join(".") || "body"),
      );
      return;
    }

    try {
      const profile = await dependencies.customerRepository.update(zohoCustomerId, parsed.data);
      res.status(200).json({ profile });
    } catch (error: unknown) {
      handleProfileError(req, res, error);
    }
  });

  router.post("/fiscal-item-profiles", async (req, res) => {
    if (!dependencies.itemRepository) {
      res.status(503).json({
        error: {
          code: "FISCAL_PROFILE_REPOSITORY_UNAVAILABLE",
          message: "Fiscal item profile management is not configured.",
        },
      });
      return;
    }

    const body: unknown = req.body;
    const parsed = itemProfileSchema.safeParse(body);
    if (!parsed.success) {
      invalidBody(
        res,
        parsed.error.issues.map((issue) => issue.path.join(".") || "body"),
      );
      return;
    }

    try {
      const profile = await dependencies.itemRepository.create(parsed.data);
      res
        .location(
          `/integrations/zoho/fiscal-item-profiles/${encodeURIComponent(profile.zohoItemId)}`,
        )
        .status(201)
        .json({ profile });
    } catch (error: unknown) {
      handleProfileError(req, res, error);
    }
  });

  router.get("/fiscal-item-profiles/:zohoItemId", async (req, res) => {
    if (!dependencies.itemRepository) {
      res.status(503).json({
        error: {
          code: "FISCAL_PROFILE_REPOSITORY_UNAVAILABLE",
          message: "Fiscal item profile management is not configured.",
        },
      });
      return;
    }

    const zohoItemId = typeof req.params["zohoItemId"] === "string" ? req.params["zohoItemId"] : "";

    try {
      const profile = await dependencies.itemRepository.findByZohoItemId(zohoItemId);
      if (!profile) {
        res.status(404).json({
          error: {
            code: "FISCAL_PROFILE_NOT_FOUND",
            message: "The fiscal profile was not found.",
          },
        });
        return;
      }

      res.status(200).json({ profile });
    } catch (error: unknown) {
      handleProfileError(req, res, error);
    }
  });

  router.put("/fiscal-item-profiles/:zohoItemId", async (req, res) => {
    if (!dependencies.itemRepository) {
      res.status(503).json({
        error: {
          code: "FISCAL_PROFILE_REPOSITORY_UNAVAILABLE",
          message: "Fiscal item profile management is not configured.",
        },
      });
      return;
    }

    const zohoItemId = typeof req.params["zohoItemId"] === "string" ? req.params["zohoItemId"] : "";
    const body: unknown = req.body;
    const parsed = itemProfileDataSchema.safeParse(body);
    if (!parsed.success) {
      invalidBody(
        res,
        parsed.error.issues.map((issue) => issue.path.join(".") || "body"),
      );
      return;
    }

    try {
      const profile = await dependencies.itemRepository.update(zohoItemId, parsed.data);
      res.status(200).json({ profile });
    } catch (error: unknown) {
      handleProfileError(req, res, error);
    }
  });

  return router;
}
