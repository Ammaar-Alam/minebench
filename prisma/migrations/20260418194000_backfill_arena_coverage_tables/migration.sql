-- backfill derived arena coverage tables from existing decisive vote history

DELETE FROM "ArenaCoveragePairPrompt";
DELETE FROM "ArenaCoveragePair";
DELETE FROM "ArenaCoverageModelPrompt";

INSERT INTO "ArenaCoverageModelPrompt" ("modelId", "promptId", "decisiveVotes")
SELECT
  source."modelId",
  source."promptId",
  COUNT(*)::int AS "decisiveVotes"
FROM (
  SELECT
    matchup."modelAId" AS "modelId",
    matchup."promptId" AS "promptId"
  FROM "Vote" vote
  INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
  WHERE vote.choice IN ('A', 'B')

  UNION ALL

  SELECT
    matchup."modelBId" AS "modelId",
    matchup."promptId" AS "promptId"
  FROM "Vote" vote
  INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
  WHERE vote.choice IN ('A', 'B')
) source
GROUP BY source."modelId", source."promptId";

INSERT INTO "ArenaCoveragePair" ("modelLowId", "modelHighId", "decisiveVotes")
SELECT
  LEAST(matchup."modelAId", matchup."modelBId") AS "modelLowId",
  GREATEST(matchup."modelAId", matchup."modelBId") AS "modelHighId",
  COUNT(*)::int AS "decisiveVotes"
FROM "Vote" vote
INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
WHERE vote.choice IN ('A', 'B')
GROUP BY
  LEAST(matchup."modelAId", matchup."modelBId"),
  GREATEST(matchup."modelAId", matchup."modelBId");

INSERT INTO "ArenaCoveragePairPrompt" ("modelLowId", "modelHighId", "promptId", "decisiveVotes")
SELECT
  LEAST(matchup."modelAId", matchup."modelBId") AS "modelLowId",
  GREATEST(matchup."modelAId", matchup."modelBId") AS "modelHighId",
  matchup."promptId" AS "promptId",
  COUNT(*)::int AS "decisiveVotes"
FROM "Vote" vote
INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
WHERE vote.choice IN ('A', 'B')
GROUP BY
  LEAST(matchup."modelAId", matchup."modelBId"),
  GREATEST(matchup."modelAId", matchup."modelBId"),
  matchup."promptId";
