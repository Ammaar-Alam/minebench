export function isSavedGenerationRecovery(errorCode: string | null | undefined, imported = false, hasSavedSource = false): boolean {
  // generation_failed covers both provider failures and retained execution failures
  return imported || (errorCode === "generation_failed" && hasSavedSource) || [
    "lease_expired", "provider_key_expired", "artifact_bookkeeping_failed",
    "processing_capacity_exceeded", "heap_limit_exceeded",
  ].includes(errorCode ?? "");
}
