// Supabase exposes one database through two endpoint shapes: a direct
// connection at db.<ref>.supabase.co and a pooled connection whose hostname is
// shared by every project in a region, with the project carried in the
// username as <role>.<ref>. Comparing hostnames is therefore both too weak
// (two projects can share a pooler host) and too strict (the same project
// looks different through each endpoint). The project ref is the stable
// identity, and it is not a secret.

export function supabaseProjectRefFromDatabaseUrl(databaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }

  const user = decodeURIComponent(url.username || "");
  const hostname = url.hostname.replace(/\.$/, "");
  const pooledMatch = /\.pooler\.supabase\.(co|com|net)$/i.test(hostname)
    ? user.match(/^.+\.([a-z0-9]{16,})$/i)
    : null;
  if (pooledMatch) return pooledMatch[1].toLowerCase();

  const directMatch = url.hostname.match(/^db\.([a-z0-9]{16,})\.supabase\.(co|com|net)$/i);
  if (directMatch) return directMatch[1].toLowerCase();

  return null;
}

export type DatabaseIdentity = {
  projectRef: string | null;
  host: string;
  port: string;
  database: string;
  schema: string;
};

export function databaseIdentityFromUrl(databaseUrl: string): DatabaseIdentity | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  return {
    projectRef: supabaseProjectRefFromDatabaseUrl(databaseUrl),
    host: url.hostname.toLowerCase().replace(/\.$/, ""),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase() || "postgres",
    schema: (url.searchParams.get("schema")?.trim() || "public").toLowerCase(),
  };
}

export function isLoopbackDatabaseUrl(databaseUrl: string): boolean {
  const identity = databaseIdentityFromUrl(databaseUrl);
  return (
    identity != null &&
    (identity.host === "localhost" ||
      identity.host === "127.0.0.1" ||
      identity.host === "[::1]")
  );
}

// Same database? Prefer the project ref, which survives the direct/pooled
// difference. Database and schema remain part of the identity even when both
// endpoints expose a project ref.
export function isSameDatabaseTarget(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  if (a.database !== b.database || a.schema !== b.schema) return false;
  if (a.projectRef || b.projectRef) return a.projectRef === b.projectRef;
  return a.host === b.host && a.port === b.port;
}

// The uploader writes to SUPABASE_URL independently of the database, so a
// publication can address one project's database while overwriting another's
// storage. This derives the project ref from the storage endpoint so the two
// can be compared.
export function supabaseProjectRefFromApiUrl(apiUrl: string): string | null {
  try {
    const { hostname } = new URL(apiUrl);
    const match = hostname.match(/^([a-z0-9]{16,})\.supabase\.(co|com|net)$/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}
