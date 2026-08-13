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
-- Server access uses the table owner and service role, which are unaffected
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'Model', 'Prompt', 'Build', 'Matchup', 'Vote',
    'ArenaVoteJob', 'ArenaShownJob', 'ModelRankSnapshot',
    'ArenaCoverageModelPrompt', 'ArenaCoveragePair', 'ArenaCoveragePairPrompt',
    '_prisma_migrations'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY "deny_client_access" ON %I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      tbl
    );
  END LOOP;
END $$;
