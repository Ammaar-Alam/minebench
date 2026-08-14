// Supabase exposes one database through two endpoint shapes: a direct
// connection at db.<ref>.supabase.co and a pooled connection whose hostname is
// shared by every project in a region, with the project carried in the
// username as postgres.<ref>. Comparing hostnames is therefore both too weak
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
  const pooledMatch = user.match(/^postgres\.([a-z0-9]{16,})$/i);
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
  };
}

// Same database? Prefer the project ref, which survives the direct/pooled
// difference. Without a ref on both sides, fall back to the full endpoint
// triple rather than the hostname alone.
export function isSameDatabaseTarget(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  if (a.projectRef && b.projectRef) return a.projectRef === b.projectRef;
  return a.host === b.host && a.port === b.port && a.database === b.database;
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
