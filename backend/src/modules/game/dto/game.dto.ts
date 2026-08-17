import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class PriorGuessDto {
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsString({ each: true })
  words!: string[];

  @IsEnum(["correct", "incorrect", "oneAway"] as const)
  result!: "correct" | "incorrect" | "oneAway";
}

export class SolveDto {
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  puzzleWords!: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriorGuessDto)
  priorGuesses?: PriorGuessDto[];
}

export interface ProposedGroupDto {
  word_ids: number[];
  reasoning: string;
}

export interface SolveUsageDto {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface PromptMetadataDto {
  attempt: number;
  temperature: number;
  model: string;
  contextWindow: number;
  latencyMs: number;
  usage?: SolveUsageDto;
  outcome: "accepted" | "duplicate_rejected" | "invalid" | "error";
}

export interface SolveResponseDto {
  proposedGroup: ProposedGroupDto;
  prompt: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
  temperature?: number;
  usage?: SolveUsageDto;
  promptMetadata?: PromptMetadataDto[];
}

export class ChatMessageDto {
  @IsIn(["user", "assistant"] as const)
  role!: "user" | "assistant";

  @IsString()
  @IsNotEmpty()
  content!: string;
}

export class DiagnoseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];
}

export interface AssistResponseDto {
  response: string;
  groups: string[][];
  model: string;
}
