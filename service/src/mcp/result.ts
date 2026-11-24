import { EchoError, serviceError } from '../errors';

export type ToolResult = { isError?: true; content: { type: 'text'; text: string }[] };

const text = (t: string): { type: 'text'; text: string } => ({ type: 'text', text: t });

/**
 * Runs a tool body. A value becomes JSON text. An EchoError becomes an error result that says whether the
 * caller broke a rule ("Refused") or Echo had a problem, plus what to do. Anything else is reported as an
 * internal service problem without its internals.
 */
export async function toolResult(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [text(JSON.stringify(await fn()))] };
  } catch (e) {
    if (!(e instanceof EchoError)) console.error('echo mcp tool failed', e);
    const err = e instanceof EchoError ? e : serviceError('INTERNAL', 'Echo hit an unexpected problem.');
    const head = err.kind === 'rule' ? `Refused (rule ${err.code})` : `Echo service problem (${err.code})`;
    return { isError: true, content: [text(`${head}: ${err.message}\nWhat to do: ${err.fix}${err.details === undefined ? '' : `\nDetails: ${JSON.stringify(err.details)}`}`)] };
  }
}
