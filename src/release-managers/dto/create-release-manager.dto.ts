import { IsEmail, IsString, IsOptional } from 'class-validator';

export class CreateReleaseManagerDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  relationship: string;

  @IsString()
  @IsOptional()
  phone_number?: string;
}
