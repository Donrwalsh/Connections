import { DataSource } from "typeorm";
import { CategoryEvaluation } from "./category-evaluation.entity";
import { LlmProposal } from "./llm-proposal.entity";
import { StrategyRun } from "./strategy-run.entity";
import { SolvePrompt } from "./solve-prompt.entity";
import { Guess } from "./guess.entity";
import { AnswerGroup } from "../../game/entities/answer-group.entity";
import { GroupMember } from "../../game/entities/group-member.entity";
import { Puzzle } from "../../game/entities/puzzle.entity";

describe("CategoryEvaluation entity metadata", () => {
  it("maps to the CategoryEvaluation table with the expected columns", async () => {
    const ds = new DataSource({
      type: "postgres",
      // CategoryEvaluation's ManyToOne targets plus their transitive
      // closure — enough for the metadata graph to resolve every relation.
      entities: [
        CategoryEvaluation,
        LlmProposal,
        StrategyRun,
        SolvePrompt,
        Guess,
        AnswerGroup,
        GroupMember,
        Puzzle,
      ],
    });
    // Build metadata without opening a DB connection (initialize() would
    // connect); getMetadata needs the metadata graph to exist first.
    await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const meta = ds.getMetadata(CategoryEvaluation);
    expect(meta.tableName).toBe("CategoryEvaluation");
    const cols = meta.columns.map((c) => c.databaseName);
    for (const expected of [
      "id",
      "llmProposalId",
      "strategyRunId",
      "answerGroupId",
      "verdict",
      "rationale",
      "proposedCategory",
      "actualCategory",
      "status",
      "evaluatorVersion",
      "judgeModel",
      "judgeProvider",
      "requestBody",
      "responseHeaders",
      "responseBody",
      "rawResponseText",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "latencyMs",
      "evaluatedAt",
    ]) {
      expect(cols).toContain(expected);
    }
    const unique = meta.indices.find((i) => i.isUnique);
    expect(unique?.columns.map((c) => c.databaseName)).toEqual(["llmProposalId"]);
  });
});
