export interface CreateProjectInput {
  name: string;
  description?: string;
  overview?: string;
  scopes?: string;
  clientName?: string;
  // A client from the Clients section; null = the workspace's own "Company Projects"
  clientId?: string | null;
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
