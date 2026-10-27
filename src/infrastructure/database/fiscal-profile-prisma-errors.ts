function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasIdentityTarget(target: unknown, identityField: string): boolean {
  if (typeof target === "string") {
    return target.includes(identityField);
  }

  return (
    Array.isArray(target) &&
    target.some((field: unknown) => typeof field === "string" && field.includes(identityField))
  );
}

export function isProfileIdentityConflict(error: unknown, identityField: string): boolean {
  if (!isRecord(error) || error["code"] !== "P2002" || !isRecord(error["meta"])) {
    return false;
  }

  const meta = error["meta"];

  if ("target" in meta) {
    return hasIdentityTarget(meta["target"], identityField);
  }

  const adapterError = meta["driverAdapterError"];
  if (!isRecord(adapterError) || !isRecord(adapterError["cause"])) {
    return false;
  }

  const constraint = adapterError["cause"]["constraint"];
  return (
    isRecord(constraint) &&
    typeof constraint["index"] === "string" &&
    constraint["index"].includes(identityField)
  );
}

export function isPrismaRecordNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "P2025";
}
