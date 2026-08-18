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
 * The word order a fresh run starts with, keyed by strategy. Extracted out of
 * loadOrCreateRun so the prompt-reconstruction path (strategy.service.ts) can
 * recompute the exact same starting order for an LLM run without duplicating
 * this switch and risking drift.
 */
export function computeInitialWordOrder(puzzle: Puzzle, strategyName: string): string[] {
  switch (strategyName) {
    case "order":
    case SHUFFLE_SMART:
    case SHUFFLE_FOOLISH:
    case LLM_OPENAI:
    case LLM_OLLAMA:
      return puzzle.answerGroups
        .flatMap((group) => group.members)
        .sort((a, b) => a.position - b.position)
        .map((m) => m.word);

    case "reverse-order":
      return puzzle.answerGroups
        .flatMap((group) => group.members)
        .sort((a, b) => b.position - a.position)
        .map((m) => m.word);

    case "reverse-alphabetical":
      return puzzle.answerGroups
        .flatMap((group) => group.members.map((m) => m.word))
        .sort((a, b) => b.localeCompare(a));

    case "alphabetical":
    default:
      return puzzle.answerGroups
        .flatMap((group) => group.members.map((m) => m.word))
        .sort((a, b) => a.localeCompare(b));
  }
}

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

    const allWords = computeInitialWordOrder(puzzle, strategyName);

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
      // 1. Insert SolvePrompt rows first and capture the generated IDs. Most
      // recently inserted ID is the default link target; when a batch holds
      // more than one prompt, proposals resolve to their specific prompt via
      // promptNumber instead.
      let insertedSolvePromptId: number | undefined;
      const solvePromptIdByPromptNumber = new Map<number, number>();
      if (promptsToInsert.length > 0) {
        const result = await manager.insert("SolvePrompt", promptsToInsert);
        const identifiers = result?.identifiers ?? [];
        promptsToInsert.forEach((prompt, i) => {
          const id = identifiers[i]?.id;
          if (id === undefined) return;
          if (prompt.promptNumber !== undefined) {
            solvePromptIdByPromptNumber.set(prompt.promptNumber, id);
          }
          insertedSolvePromptId = id;
        });
      }

      // 2. Insert Guess rows and capture each row's own generated ID for
      // linking — a single flush can carry more than one guess (the LLM can
      // get several groups right in one response), so proposals must be
      // paired with their own guess, not just the first one inserted.
      const guessIdByGuess = new Map<object, number>();
      if (guessesToInsert.length > 0) {
        const result = await manager.insert("Guess", guessesToInsert);
        const identifiers = result?.identifiers ?? [];
        guessesToInsert.forEach((guess, i) => {
          const id = identifiers[i]?.id;
          if (id !== undefined) {
            guessIdByGuess.set(guess, id);
          }
        });
      }

      // 3. Insert LlmProposal rows using the captured foreign keys.
      if (proposalsToInsert.length > 0) {
        await manager.insert(
          "LlmProposal",
          proposalsToInsert.map((proposal) => {
            const resolved: Record<string, unknown> = { ...proposal };

            // Strip away transient properties if present on the partial entity
            const promptNumber = resolved.promptNumber as number | undefined;
            delete resolved.promptNumber;

            // Link to the newly inserted SolvePrompt if not set
            if (!resolved.solvePromptId) {
              const resolvedSolvePromptId =
                (promptNumber !== undefined
                  ? solvePromptIdByPromptNumber.get(promptNumber)
                  : undefined) ?? insertedSolvePromptId;
              if (resolvedSolvePromptId !== undefined) {
                resolved.solvePromptId = resolvedSolvePromptId;
              }
            }

            // Link the 'used' proposal to the guess it became — matched by
            // object identity against the guess it was paired with in memory.
            if (resolved.status === LlmProposalStatus.USED && proposal.guess) {
              const guessId = guessIdByGuess.get(proposal.guess);
              if (guessId !== undefined) {
                resolved.guessId = guessId;
              }
            }

            return resolved;
          }),
        );
      }

      await manager.save(StrategyRun, run);
    });
  }
}
