CREATE TABLE "Puzzle" (
    "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "date" DATE NOT NULL,

    CONSTRAINT "UQ_Puzzle_date" UNIQUE ("date")
);

CREATE TABLE "AnswerGroup" (
    "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "puzzle_id" INT NOT NULL REFERENCES "Puzzle"("id"),
    "level" INT NOT NULL,
    "group_name" TEXT NOT NULL
);

CREATE UNIQUE INDEX "UQ_AnswerGroup_puzzle_level" ON "AnswerGroup" ("puzzle_id", "level");

CREATE TABLE "GroupMember" (
    "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "group_id" INT NOT NULL REFERENCES "AnswerGroup"("id"),
    "word" TEXT NOT NULL,
    "position" INT NOT NULL
);

CREATE UNIQUE INDEX "UQ_GroupMember_group_word" ON "GroupMember" ("group_id", "word");

CREATE TYPE strategy_run_status_enum AS ENUM (
  'running',
  'completed',
  'failed',
  'duplicate',
  'malformedResponse',
  'error'
);

CREATE TABLE "StrategyRun" (
  "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "puzzleId" INT NOT NULL REFERENCES "Puzzle"("id") ON DELETE CASCADE,
  "strategyName" VARCHAR NOT NULL,
  "trialNumber" INT NOT NULL DEFAULT 0,
  "status" strategy_run_status_enum NOT NULL DEFAULT 'running',
  "availableWords" JSONB NOT NULL,
  "currentCombination" JSONB NOT NULL,
  "modelName" VARCHAR NULL,
  "contextWindow" INT NULL,
  "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP WITH TIME ZONE NULL,

  CONSTRAINT "UQ_StrategyRun_puzzle_strategyName_trialNumber" UNIQUE ("puzzleId", "strategyName", "trialNumber")
);

CREATE TYPE guess_result_enum AS ENUM (
  'success',
  'failure',
  'offBy1',
  'duplicate'
);

CREATE TYPE guess_source_enum AS ENUM (
  'user',
  'strategy'
);

CREATE TABLE "Guess" (
  "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "puzzleId" INT NOT NULL REFERENCES "Puzzle"("id") ON DELETE CASCADE,
  "strategyRunId" INT NULL REFERENCES "StrategyRun"("id") ON DELETE SET NULL,
  "words" JSONB NOT NULL,
  "result" guess_result_enum NOT NULL,
  "sequenceNumber" INT NOT NULL,
  "source" guess_source_enum NOT NULL,
  "promptTokens" INT NULL,
  "completionTokens" INT NULL,
  "totalTokens" INT NULL,
  "latencyMs" INT NULL,
  "temperature" DOUBLE PRECISION NULL,
  "numResponses" INT NULL,
  "promptAttempts" INT NULL,
  "duplicatesRejected" INT NULL,
  "llmDetails" JSONB NULL,
  "guessedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "IDX_Guess_puzzleId" ON "Guess" ("puzzleId");
CREATE INDEX "IDX_Guess_strategyRun_sequenceNumber" 
  ON "Guess" ("strategyRunId", "sequenceNumber") INCLUDE ("words");

CREATE TYPE llm_proposal_status_enum AS ENUM (
  'used',
  'rejected_duplicate',
  'not_selected'
);

-- One row per LLM candidate group proposed by the orchestrator across every
-- prompt of a solve step, including the ones that were rejected or never
-- used. 'used' rows link to the Guess record they produced; 'rejected_duplicate'
-- rows repeated a prior guess; 'not_selected' rows were fresh and well-formed
-- but a higher-confidence proposal in the same batch won instead.
CREATE TABLE "LlmProposal" (
  "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "strategyRunId" INT NOT NULL REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
  "guessId" INT NULL REFERENCES "Guess"("id") ON DELETE SET NULL,
  "promptNumber" INT NOT NULL,
  "guessNumber" INT NULL,
  "words" JSONB NOT NULL,
  "category" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "reasoning" TEXT NOT NULL,
  "status" llm_proposal_status_enum NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "IDX_LlmProposal_strategyRunId" ON "LlmProposal" ("strategyRunId");
CREATE INDEX "IDX_LlmProposal_guessId" ON "LlmProposal" ("guessId");
