import { McpServer } from '@modelcontextprotocol/server';
import type { Ctx } from '../ctx';
import type { AgentRow } from '../domain/agents';
import { registerTools } from './tools';

/** A fresh server for one request, bound to the authenticated agent. Nothing is kept between requests. */
export function createEchoServer(ctx: Ctx, agent: AgentRow): McpServer {
  const server = new McpServer({ name: 'echo', version: '1.0.0' });
  registerTools(server, ctx, agent);
  return server;
}
