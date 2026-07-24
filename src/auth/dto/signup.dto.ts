import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  last_name?: string;

  // Set when signup was reached via an invitation link
  // (`/auth/signup?invite_token=...`). The actual acceptance happens
  // client-side (AuthContext.finalizePendingInvite) once a session exists —
  // this is accepted here only so the whitelist validator doesn't reject the
  // request; it isn't currently read server-side.
  @IsOptional()
  @IsString()
  invite_token?: string;

  // Acquisition attribution — collected client-side (landing URL + referrer)
  // and passed through so user_signed_up carries it server-side. Non-PII.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  acquisition_source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_medium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_campaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_term?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  referrer?: string;
}
