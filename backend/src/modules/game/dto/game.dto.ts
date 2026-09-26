import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";

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

  // The puzzle's full original word list, forwarded so the orchestrator's
  // parser keeps board words it would otherwise strip (e.g. "TEE (GOLF)",
  // "YO-YO"). Optional so an older frontend build keeps working.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  boardWords?: string[];
}

export interface AssistResponseDto {
  response: string;
  groups: string[][];
  model: string;
}
