export function addBusinessDays(date: Date, days: number): Date {
  let count = 0;
  const result = new Date(date);
  while (count < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) count++; // skip Saturday (6) and Sunday (0)
  }
  return result;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

const CONTENT_TYPE_KEYS: Record<string, string> = {
  photo: 'photos',
  chapter: 'memoir_chapters',
  document: 'documents',
  message: 'messages',
};

// recipients.relationship is family/friend/other; content_assignments.group_value
// uses family/friends/others (see access.service.ts for the same mapping).
export function relationshipToGroupValue(relationship: string): string {
  if (relationship === 'family') return 'family';
  if (relationship === 'friend') return 'friends';
  return 'others';
}

export function emptyContentSummary() {
  return { photos: 0, memoir_chapters: 0, documents: 0, messages: 0, total: 0 };
}

export function computeContentSummary(
  assignments: Array<{
    content_type: string;
    content_id: string;
    assignment_scope: string;
    group_value: string | null;
    recipient_id: string | null;
  }>,
  recipient: { id: string; relationship: string },
) {
  const summary = emptyContentSummary();
  const groupValue = relationshipToGroupValue(recipient.relationship);
  const seen = new Set<string>();

  for (const a of assignments) {
    const key = CONTENT_TYPE_KEYS[a.content_type];
    if (!key) continue;

    const matches =
      (a.assignment_scope === 'individual' && a.recipient_id === recipient.id) ||
      (a.assignment_scope === 'group' && a.group_value === groupValue) ||
      a.assignment_scope === 'all';

    if (!matches) continue;

    const dedupeKey = `${a.content_type}:${a.content_id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    (summary as any)[key] += 1;
    summary.total += 1;
  }

  return summary;
}
