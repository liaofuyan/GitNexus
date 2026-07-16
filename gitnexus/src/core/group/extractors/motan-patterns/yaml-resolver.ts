/**
 * Resolve Motan `group` config from Spring Boot YAML files.
 *
 * The `motan-spring-boot-starter` (in `common-starter`) builds the shared
 * `basicService`/`basicReferer` config beans programmatically from
 * `uxin.motan.*` properties in `bootstrap-*.yml`.  These beans carry the
 * `group` that individual `<motan:service>`/`<motan:referer>` elements
 * reference by id - so YAML is a first-class group source alongside inline
 * `<motan:basicService>`/`<motan:basicReferer>` in XML.
 *
 * Default bean names from the starter: `serviceBasicConfig` (server) and
 * `clientBasicConfig` (client).  Default group `motan-ulive-rpc`.
 */

import { createRequire } from 'node:module';
import type { MotanBasicConfig } from './types.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

interface BasicEntry {
  group?: string;
  export?: string;
}

interface MotanYamlConfig {
  server?: BasicEntry;
  client?: BasicEntry;
  'basic-services'?: Record<string, BasicEntry>;
  basicServices?: Record<string, BasicEntry>;
  'basic-referers'?: Record<string, BasicEntry>;
  basicReferers?: Record<string, BasicEntry>;
}

function basicEntries(map?: Record<string, BasicEntry>): MotanBasicConfig[] {
  if (!map) return [];
  const out: MotanBasicConfig[] = [];
  for (const [id, v] of Object.entries(map)) {
    if (v?.group) out.push({ id, group: v.group, export: v.export, source: 'yaml' });
  }
  return out;
}

/**
 * Parse one YAML file and return any motan basic-config beans it defines.
 * Returns `[]` when the file has no `uxin.motan.*` section or fails to parse.
 */
export function parseMotanYaml(content: string): MotanBasicConfig[] {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const uxin = (parsed as Record<string, unknown>).uxin;
  if (!uxin || typeof uxin !== 'object') return [];
  const motan = (uxin as Record<string, unknown>).motan;
  if (!motan || typeof motan !== 'object') return [];

  const cfg = motan as MotanYamlConfig;
  const configs: MotanBasicConfig[] = [];

  // Default server/client beans built by the starter from uxin.motan.server /
  // uxin.motan.client.  These map to bean names `serviceBasicConfig` and
  // `clientBasicConfig` respectively.
  if (cfg.server?.group) {
    configs.push({ id: 'serviceBasicConfig', group: cfg.server.group, export: cfg.server.export, source: 'yaml' });
  }
  if (cfg.client?.group) {
    configs.push({ id: 'clientBasicConfig', group: cfg.client.group, export: cfg.client.export, source: 'yaml' });
  }

  // Named basic configs: uxin.motan.basic-services.<id> / basic-referers.<id>.
  // Accept both kebab-case (Spring relaxed binding) and camelCase keys.
  configs.push(...basicEntries(cfg['basic-services'] ?? cfg.basicServices));
  configs.push(...basicEntries(cfg['basic-referers'] ?? cfg.basicReferers));

  return configs;
}