-- derived coverage tables for arena matchmaking hot path

CREATE TABLE "ArenaCoverageModelPrompt" (
    "modelId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "decisiveVotes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArenaCoverageModelPrompt_pkey" PRIMARY KEY ("modelId","promptId")
);

CREATE TABLE "ArenaCoveragePair" (
    "modelLowId" TEXT NOT NULL,
    "modelHighId" TEXT NOT NULL,
    "decisiveVotes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArenaCoveragePair_pkey" PRIMARY KEY ("modelLowId","modelHighId")
);

CREATE TABLE "ArenaCoveragePairPrompt" (
    "modelLowId" TEXT NOT NULL,
    "modelHighId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "decisiveVotes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArenaCoveragePairPrompt_pkey" PRIMARY KEY ("modelLowId","modelHighId","promptId")
);

CREATE INDEX "ArenaCoverageModelPrompt_promptId_idx" ON "ArenaCoverageModelPrompt"("promptId");
CREATE INDEX "ArenaCoveragePairPrompt_promptId_idx" ON "ArenaCoveragePairPrompt"("promptId");

ALTER TABLE "ArenaCoverageModelPrompt"
ADD CONSTRAINT "ArenaCoverageModelPrompt_modelId_fkey"
FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArenaCoverageModelPrompt"
ADD CONSTRAINT "ArenaCoverageModelPrompt_promptId_fkey"
FOREIGN KEY ("promptId") REFERENCES "Prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArenaCoveragePair"
ADD CONSTRAINT "ArenaCoveragePair_modelLowId_fkey"
FOREIGN KEY ("modelLowId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArenaCoveragePair"
ADD CONSTRAINT "ArenaCoveragePair_modelHighId_fkey"
FOREIGN KEY ("modelHighId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArenaCoveragePairPrompt"
ADD CONSTRAINT "ArenaCoveragePairPrompt_modelLowId_fkey"
FOREIGN KEY ("modelLowId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArenaCoveragePairPrompt"
ADD CONSTRAINT "ArenaCoveragePairPrompt_modelHighId_fkey"
FOREIGN KEY ("modelHighId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArenaCoveragePairPrompt"
ADD CONSTRAINT "ArenaCoveragePairPrompt_promptId_fkey"
FOREIGN KEY ("promptId") REFERENCES "Prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
