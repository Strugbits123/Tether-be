import { Equals, IsIn, IsOptional } from 'class-validator';

export class DesignateGuardianDto {
  // Slots are 1..MAX_GUARDIANS (guardians.service.ts). Kept as a literal because
  // class-validator decorators are evaluated at class-definition time.
  @IsOptional()
  @IsIn([1, 2])
  priority_order?: number;

  @Equals(true, { message: 'legal_acknowledged must be true' })
  legal_acknowledged: boolean;
}
