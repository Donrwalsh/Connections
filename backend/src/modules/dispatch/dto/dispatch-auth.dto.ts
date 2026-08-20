import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class DispatchAuthDto {
  @ApiPropertyOptional({
    type: String,
    description:
      "Required only when the server is running in production — must match its" +
      " DISPATCH_PASSWORD. Ignored everywhere else.",
  })
  @IsOptional()
  @IsString()
  password?: string;
}
