import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};
export type FakeReply = { status: number; body?: unknown; delayMs?: number; headers?: Record<string, string> };

export type FakeServer = {
  url: string;
  requests: RecordedRequest[];
  /** Set what the server answers next (sticky until changed). */
  reply(r: FakeReply | ((req: RecordedRequest) => FakeReply)): void;
  close(): Promise<void>;
};

export async function startFakeServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let responder: (req: RecordedRequest) => FakeReply = () => ({ status: 200, body: { ok: true } });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      const r = responder(rec);
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(r.body === undefined ? '' : JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(r) {
      responder = typeof r === 'function' ? r : () => r;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
