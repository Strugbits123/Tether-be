export interface CreateGuardianData {
  accountId: string;
  name: string;
  email: string;
  relationship: string;
  priorityOrder: number;
  userId?: string | null;
}
