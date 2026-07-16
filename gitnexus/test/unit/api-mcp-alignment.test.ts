import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Static analysis guard: every MCP tool should have a REST endpoint
 * thin-wrapping `backend.callTool()` via the `registerMcpRoute` helper.
 *
 * If you add a new MCP tool without adding the corresponding REST route,
 * the assertions below will fail - keeping the API-MCP parity contract
 * explicit at the static-analysis layer.
 */

interface EndpointSpec {
  /** MCP tool name (callTool method). */
  tool: string;
  /** REST route path. */
  route: string;
  method: 'get' | 'post';
  /** Mutating tools get requireLocalhostOrigin. */
  mutating?: boolean;
}

const ENDPOINTS: EndpointSpec[] = [
  { tool: 'cypher', route: '/api/cypher', method: 'post' },
  { tool: 'context', route: '/api/context', method: 'post' },
  { tool: 'impact', route: '/api/impact', method: 'post' },
  { tool: 'trace', route: '/api/trace', method: 'post' },
  { tool: 'detect_changes', route: '/api/detect-changes', method: 'post' },
  { tool: 'check', route: '/api/check', method: 'post' },
  { tool: 'rename', route: '/api/rename', method: 'post', mutating: true },
  { tool: 'explain', route: '/api/explain', method: 'post' },
  { tool: 'pdg_query', route: '/api/pdg-query', method: 'post' },
  { tool: 'route_map', route: '/api/route-map', method: 'post' },
  { tool: 'tool_map', route: '/api/tool-map', method: 'post' },
  { tool: 'shape_check', route: '/api/shape-check', method: 'post' },
  { tool: 'api_impact', route: '/api/api-impact', method: 'post' },
  { tool: 'group_list', route: '/api/groups', method: 'get' },
  { tool: 'group_sync', route: '/api/groups/sync', method: 'post', mutating: true },
];

describe('API-MCP alignment', () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
  });

  it('defines registerMcpRoute helper backed by backend.callTool', () => {
    expect(source).toContain('registerMcpRoute');
    expect(source).toContain('backend.callTool');
  });

  for (const ep of ENDPOINTS) {
    it(`registers ${ep.method.toUpperCase()} ${ep.route} -> callTool('${ep.tool}')${ep.mutating ? ' [mutating]' : ''}`, () => {
      // Match the full registerMcpRoute(...) call for this endpoint.
      const escapedRoute = ep.route.replace(/\//g, '\\/');
      const re = new RegExp(
        `registerMcpRoute\\('${ep.method}',\\s*'${escapedRoute}',\\s*'${ep.tool}'[^)]*\\)`,
      );
      const m = source.match(re);
      expect(m, `registerMcpRoute call for ${ep.route} ('${ep.tool}') not found`).not.toBeNull();
      const call = m![0];
      if (ep.mutating) {
        expect(call, `${ep.route} must require localhost (mutating: true)`).toContain(
          'mutating: true',
        );
      } else {
        expect(call, `${ep.route} must NOT be mutating`).not.toContain('mutating: true');
      }
    });
  }
});