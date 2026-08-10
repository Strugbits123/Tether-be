import { Equals, IsIn, IsOptional } from 'class-validator';
import { GUARDIAN_SLOT_VALUES } from '../../guardians/guardians.constants.js';

export class DesignateGuardianDto {
  // Derived from MAX_GUARDIANS rather than written out, so this can't drift from
  // the cap the service enforces.
  @IsOptional()
  @IsIn(GUARDIAN_SLOT_VALUES)
  priority_order?: number;

  @Equals(true, { message: 'legal_acknowledged must be true' })
  legal_acknowledged: boolean;
}
