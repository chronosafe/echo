import { describe, expect, it } from 'vitest';
import { EchoError, errorJson, ruleError } from '../src/errors';
import { toolResult } from '../src/mcp/result';

describe('error details', () => {
  it('leaves existing error bodies byte-identical when there are no details', () => {
    expect(errorJson(ruleError('X', 'm', 'f')).error).toEqual({ kind: 'rule', code: 'X', message: 'm', fix: 'f' });
    expect('details' in errorJson(ruleError('X', 'm', 'f', 409)).error).toBe(false);
  });

  it('carries details in the JSON body and the status', () => {
    const e = ruleError('VERSION_CONFLICT', 'm', 'f', 409, { conflicts: [{ key: 'a' }] });
    expect(e).toBeInstanceOf(EchoError);
    expect(e.status).toBe(409);
    expect(errorJson(e).error).toEqual({ kind: 'rule', code: 'VERSION_CONFLICT', message: 'm', fix: 'f', details: { conflicts: [{ key: 'a' }] } });
  });

  it('shows details in a tool refusal, and nothing extra without them', async () => {
    const plain = await toolResult(async () => {
      throw ruleError('X', 'm', 'f');
    });
    expect(plain.content[0]!.text).toBe('Refused (rule X): m\nWhat to do: f');
    const withDetails = await toolResult(async () => {
      throw ruleError('X', 'm', 'f', 409, { a: 1 });
    });
    expect(withDetails.isError).toBe(true);
    expect(withDetails.content[0]!.text).toBe('Refused (rule X): m\nWhat to do: f\nDetails: {"a":1}');
  });
});
