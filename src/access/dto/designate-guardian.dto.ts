import { Equals, IsIn, IsOptional } from 'class-validator';

export class DesignateGuardianDto {
  @IsOptional()
  @IsIn([1, 2, 3])
  priority_order?: number;

  @Equals(true, { message: 'legal_acknowledged must be true' })
  legal_acknowledged: boolean;
}
