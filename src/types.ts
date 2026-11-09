export type Role = 'techlead' | 'dev';
export const ROLES: Role[] = ['techlead', 'dev'];
export type StageId = 'clarify' | 'design' | 'implement' | 'test' | 'review' | 'fix';
export type Status = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done';
export type EntryKind = 'user' | 'text' | 'tool' | 'marker' | 'error';

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
  /** Raw detail shown only with --verbose (tool input). */
  detail?: string;
}

export const ROLE_LABEL: Record<Role, string> = { techlead: 'TECH LEAD', dev: 'SENIOR DEV' };
