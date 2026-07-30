export interface SolveResponseDto {
  proposedGroup: ProposedGroupDto;
  prompt: string;
}

export interface PriorGuessDto {
  words: string[];
  result: "correct" | "incorrect" | "oneAway";
}

export class SolveDto {
  puzzleWords!: string[];
  priorGuesses?: PriorGuessDto[];
}

export interface ProposedGroupDto {
  words: string[];
  category: string;
  confidence: number;
  reasoning: string;
}
