export const ASSIGNMENT_SCOPES = [
  'individual',
  'all',
  'group',
  'release_manager',
  'assign_later',
] as const;

export type AssignmentScope = (typeof ASSIGNMENT_SCOPES)[number];

export const GROUP_VALUES = ['family', 'friends', 'others'] as const;

export type GroupValue = (typeof GROUP_VALUES)[number];
