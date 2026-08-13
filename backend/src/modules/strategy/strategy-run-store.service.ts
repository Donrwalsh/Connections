import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess } from "./entities/guess.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
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
    // Plain indexed-column filter instead of a relation predicate so TypeORM
    // doesn't emit an unnecessary join/subquery.
    return this.guessRepo.count({
      where: { strategyRunId },
    });
  }

  async flushBatch(
    run: StrategyRun,
    pendingGuesses: Partial<Guess>[],
    pendingProposals: Partial<LlmProposal>[] = [],
  ): Promise<void> {
    // Create a shallow copy to insert and clear the original buffer. The run is
    // always saved — even with no new guesses — so terminal states reached
    // without a recorded guess (e.g. LLM malformed/error limits) persist.
    const guessesToInsert = [...pendingGuesses];
    pendingGuesses.length = 0;
    const proposalsToInsert = [...pendingProposals];
    pendingProposals.length = 0;

    await this.dataSource.transaction(async (manager) => {
      // Proposals are flushed together with the guess they belong to (one solve
      // step per flush), so a single inserted guess id links the 'used'
      // proposal to the guess that realized it.
      let insertedGuessId: number | undefined;
      if (guessesToInsert.length > 0) {
        const result = await manager.insert("Guess", guessesToInsert);
        insertedGuessId = result?.identifiers?.[0]?.id;
      }

      if (proposalsToInsert.length > 0) {
        await manager.insert(
          "LlmProposal",
          proposalsToInsert.map((proposal) =>
            proposal.status === LlmProposalStatus.USED && insertedGuessId !== undefined
              ? { ...proposal, guess: { id: insertedGuessId } as Guess }
              : proposal,
          ),
        );
      }
      await manager.save(StrategyRun, run);
    });
  }
}
