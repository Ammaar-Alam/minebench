type NumericMetadata = number | bigint | null | undefined;

export function customBuildJsonNumber(value: NumericMetadata, field: string): number | null {
  if (value == null) return null;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${field} is outside the JSON-safe integer range`);
  }
  return numeric;
}

export function customBuildStorageBigInt(value: NumericMetadata): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Custom build storage byte total is outside the supported integer range");
  }
  return BigInt(value);
}
