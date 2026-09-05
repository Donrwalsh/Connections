import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class LoginDto {
  @ApiProperty({ type: String, description: "Must match the server's DISPATCH_PASSWORD." })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
