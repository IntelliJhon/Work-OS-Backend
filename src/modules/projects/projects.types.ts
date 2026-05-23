export interface CreateProjectInput {
  name: string;
  description?: string;
  pmId?: string;
  status?: string;
}


export interface PhaseInput {
  tenantId: string;
  projectId: string;
  name: string;
  orderIndex: number;
  status: 'pending' | 'active' | 'completed';
  isLocked: boolean;
}
