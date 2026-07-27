import { IsNotEmpty, IsUUID } from 'class-validator';

export class SwitchContextDto {
  @IsNotEmpty()
  @IsUUID()
  membershipId: string;
}
