/**
 * `users.full_name` is only written when BOTH first_name and last_name are set
 * (see users.service.updateProfile), so it is blank for every account owner who
 * never finished their profile. Emails interpolate the owner's name into subject
 * lines and body copy — a blank one produces " has chosen you as their Release
 * Manager on Tether", which is what recipients were actually receiving.
 *
 * This is the single place that decides what to call an owner. Prefer it over
 * reading `full_name` directly anywhere a name is shown to a human.
 */
export interface OwnerNameSource {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

/** Last-resort label. Deliberately warm rather than clinical — it appears in
 *  bereavement emails, where "Account Owner" would read badly. */
export const OWNER_NAME_FALLBACK = 'Your loved one';

export function resolveOwnerName(
  owner: OwnerNameSource | null | undefined,
  fallback: string = OWNER_NAME_FALLBACK,
): string {
  if (!owner) return fallback;

  const full = owner.full_name?.trim();
  if (full) return full;

  // full_name is blank but the parts may not be — a profile can be half filled.
  const composed = [owner.first_name?.trim(), owner.last_name?.trim()]
    .filter(Boolean)
    .join(' ');
  if (composed) return composed;

  // The email's local part is a poor name but a real identifier, and it beats
  // an anonymous fallback when the recipient is trying to work out who this is.
  const local = owner.email?.split('@')[0]?.trim();
  if (local) return local;

  return fallback;
}
