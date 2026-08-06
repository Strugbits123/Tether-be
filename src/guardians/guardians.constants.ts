// Guardian limits, kept in their own module rather than in guardians.service.ts
// so validation DTOs can import them without pulling a Nest service (and its
// Supabase dependency) into the request-validation layer.

/**
 * Maximum number of live Guardians per account. Surfaced to the frontend as
 * stats.max_guardians (access.service.ts) so the UI greys out its designate
 * button from this same number, and enforced structurally by the
 * guardians_live_priority_uniq index in db/constraints.sql.
 */
export const MAX_GUARDIANS = 2;

/**
 * Valid priority_order values — the slots 1..MAX_GUARDIANS. Derived rather than
 * written out so the two guardian DTOs can't drift from the cap. Decorators are
 * evaluated at class-definition time, but that only requires the value to exist
 * by then; a module-level constant qualifies.
 */
export const GUARDIAN_SLOT_VALUES: number[] = Array.from(
  { length: MAX_GUARDIANS },
  (_, index) => index + 1,
);

/**
 * Shown verbatim to the account owner when they try to exceed the cap, so it
 * reads as product copy rather than a validation string. Update alongside
 * MAX_GUARDIANS — the number is spelled out deliberately.
 */
export const MAX_GUARDIANS_MESSAGE =
  'You have already selected two Guardians.';
