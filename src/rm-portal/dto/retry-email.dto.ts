import { IsEmail } from 'class-validator';

export class RetryEmailDto {
  @IsEmail()
  email: string;
}
