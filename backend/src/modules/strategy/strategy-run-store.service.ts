import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess } from "./entities/guess.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { firstCombination } from "./combinatorics";
import { SHUFFLE_SMART, SHUFFLE_FOOLISH, LLM_OPENAI, LLM_OLLAMA } from "../../strategies";

const GROUP_SIZE = 4;

/**
 * Shared persistence helpers used by both the deterministic/shuffle and LLM
 * strategy run loops: run load-or-create, guess counting, and batched DB
 * flushing (guesses plus LLM proposals) live here so neither service owns a
 * private copy of the same logic.
 */
@Injectable()
export class StrategyRunStore {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @InjectRepository(SolvePrompt)
    private readonly solvePromptRepo: Repository<SolvePrompt>,
  ) {}

  async loadOrCreateRun(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
  ): Promise<{ run: StrategyRun; puzzle: Puzzle }> {
    const puzzle = await this.puzzleRepo.findOne({
      where: { id: puzzleId },
      relations: { answerGroups: { members: true } },
    });

    if (!puzzle) throw new NotFoundException(`No puzzle with id: ${puzzleId}`);

    const existing = await this.strategyRunRepo.findOne({
      where: { puzzle: { id: puzzleId }, strategyName, trialNumber },
    });

    if (existing) {
      return { run: existing, puzzle };
    }

    let allWords: string[];

    switch (strategyName) {
      case "order":
      case SHUFFLE_SMART:
      case SHUFFLE_FOOLISH:
      case LLM_OPENAI:
      case LLM_OLLAMA:
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members)
          .sort((a, b) => a.position - b.position)
          .map((m) => m.word);
        break;

      case "reverse-order":
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members)
          .sort((a, b) => b.position - a.position)
          .map((m) => m.word);
        break;

      case "reverse-alphabetical":
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members.map((m) => m.word))
          .sort((a, b) => b.localeCompare(a));
        break;

      case "alphabetical":
      default:
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members.map((m) => m.word))
          .sort((a, b) => a.localeCompare(b));
        break;
    }

    const run = this.strategyRunRepo.create({
      puzzle,
      strategyName,
      trialNumber,
      status: StrategyRunStatus.RUNNING,
      availableWords: allWords,
      currentCombination: firstCombination(GROUP_SIZE),
    });

    const saved = await this.strategyRunRepo.save(run);
    return { run: saved, puzzle };
  }

  async countGuesses(strategyRunId: number): Promise<number> {
    return this.guessRepo.count({
      where: { strategyRunId },
    });
  }

  async countPrompts(strategyRunId: number): Promise<number> {
    return this.solvePromptRepo.count({
      where: { strategyRunId },
    });
  }

  async flushBatch(
    run: StrategyRun,
    pendingGuesses: Partial<Guess>[],
    pendingProposals: Partial<LlmProposal>[] = [],
    pendingPrompts: Partial<SolvePrompt>[] = [],
  ): Promise<void> {
    const guessesToInsert = [...pendingGuesses];
    pendingGuesses.length = 0;
    const proposalsToInsert = [...pendingProposals];
    pendingProposals.length = 0;
    const promptsToInsert = [...pendingPrompts];
    pendingPrompts.length = 0;

    await this.dataSource.transaction(async (manager) => {
      // Insert SolvePrompt rows first so their IDs are available for proposals.
      let promptIdByNumber: Map<number, number> | undefined;
      if (promptsToInsert.length > 0) {
        const result = await manager.insert("SolvePrompt", promptsToInsert);
        promptIdByNumber = new Map(
          promptsToInsert.map((p, i) => [p.promptNumber!, result.identifiers[i].id]),
        );
      }

      // Insert Guess rows and capture the inserted ID for linking proposals.
      let insertedGuessId: number | undefined;
      if (guessesToInsert.length > 0) {
        const result = await manager.insert("Guess", guessesToInsert);
        insertedGuessId = result?.identifiers?.[0]?.id;
      }

      if (proposalsToInsert.length > 0) {
        await manager.insert(
          "LlmProposal",
          proposalsToInsert.map((proposal) => {
            const resolved: Record<string, unknown> = { ...proposal };

            // Resolve promptNumber to solvePromptId if the runner sent
            // promptNumber instead of solvePromptId directly.
            if (promptIdByNumber && typeof resolved.promptNumber === "number") {
              resolved.solvePromptId = promptIdByNumber.get(resolved.promptNumber as number);
              delete resolved.promptNumber;
            }

            // Link the 'used' proposal to the guess it became.
            if (
              resolved.status === LlmProposalStatus.USED &&
              insertedGuessId !== undefined
            ) {
              resolved.guessId = insertedGuessId;
            }

            return resolved;
          }),
        );
      }
      await manager.save(StrategyRun, run);
    });
  }
}
