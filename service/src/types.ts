export type Actor =
  | { kind: 'agent'; agentId: number; name: string }
  | { kind: 'admin' }
  | { kind: 'system'; name: 'Echo' | 'github' };

export function actorLabel(a: Actor): string {
  return a.kind === 'agent' ? a.name : a.kind === 'admin' ? 'admin' : a.name;
}
