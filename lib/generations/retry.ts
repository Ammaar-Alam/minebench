export function isSavedGenerationRecovery(errorCode: string | null | undefined, imported = false): boolean {
  return imported || [
    "lease_expired", "provider_key_expired", "artifact_bookkeeping_failed",
    "processing_capacity_exceeded", "heap_limit_exceeded",
  ].includes(errorCode ?? "");
}
