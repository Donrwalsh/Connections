import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsString, ValidateNested } from "class-validator";

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
