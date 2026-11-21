export type HookInput = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: { command?: string };
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
  stop_hook_active?: boolean;
};

/** Parse the JSON Claude Code writes to a hook's stdin. Throws on anything unusable. */
export function readInput(stdin: string): HookInput {
  const v: unknown = JSON.parse(stdin);
  if (typeof v !== 'object' || v === null) throw new Error('hook input is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.hook_event_name !== 'string') throw new Error('hook input has no hook_event_name');
  return {
    ...(o as unknown as HookInput),
    session_id: typeof o.session_id === 'string' ? o.session_id : '',
    cwd: typeof o.cwd === 'string' ? o.cwd : process.cwd(),
  };
}
