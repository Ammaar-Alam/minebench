-- Enable row level security on every public table
-- The first six were enabled from the dashboard in production; declaring them
-- here keeps local databases built from migrations in the same state
-- Client roles hold no grants on any public table, so this is defense in depth
ALTER TABLE "Model" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Prompt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Build" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Matchup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Vote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArenaVoteJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArenaShownJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModelRankSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArenaCoverageModelPrompt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArenaCoveragePair" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArenaCoveragePairPrompt" ENABLE ROW LEVEL SECURITY;

-- Explicit deny policies document intent for the security advisor
-- Server access uses the table owner and service role, which are unaffected.
-- anon and authenticated are Supabase-provisioned roles: a local Postgres from
-- compose.yaml has neither, and CREATE POLICY resolves roles at execution
-- time, so the policy is scoped to whichever of them actually exists.
DO $$
DECLARE
  tbl text;
  client_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO client_roles
    FROM pg_roles
   WHERE rolname IN ('anon', 'authenticated');

  IF client_roles IS NULL THEN
    RAISE NOTICE 'Skipping deny policies: neither anon nor authenticated exists';
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY ARRAY[
    'Model', 'Prompt', 'Build', 'Matchup', 'Vote',
    'ArenaVoteJob', 'ArenaShownJob', 'ModelRankSnapshot',
    'ArenaCoverageModelPrompt', 'ArenaCoveragePair', 'ArenaCoveragePairPrompt',
    '_prisma_migrations'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY "deny_client_access" ON %I FOR ALL TO %s USING (false) WITH CHECK (false)',
      tbl,
      client_roles
    );
  END LOOP;
END $$;
