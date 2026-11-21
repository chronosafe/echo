export class EchoError extends Error {
  constructor(
    public kind: 'rule' | 'service',
    public code: string,
    message: string,
    public fix: string,
    public status: number,
  ) {
    super(message);
    this.name = 'EchoError';
  }
}

export function ruleError(code: string, message: string, fix: string, status = 400): EchoError {
  return new EchoError('rule', code, message, fix, status);
}

export function serviceError(code: string, message: string): EchoError {
  return new EchoError(
    'service',
    code,
    message,
    'Your request was not applied. Retry shortly; if it keeps failing, tell the owner.',
    503,
  );
}

export type ErrorBody = {
  ok: false;
  error: { kind: 'rule' | 'service'; code: string; message: string; fix: string };
};

export function errorJson(e: unknown): ErrorBody {
  const err = e instanceof EchoError ? e : serviceError('INTERNAL', 'Echo hit an unexpected problem.');
  return { ok: false, error: { kind: err.kind, code: err.code, message: err.message, fix: err.fix } };
}

export function errorStatus(e: unknown): number {
  return e instanceof EchoError ? e.status : 500;
}
