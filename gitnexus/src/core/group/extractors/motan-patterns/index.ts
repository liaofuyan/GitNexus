/**
 * Motan contract resolution entry point.
 *
 * Two-pass algorithm:
 *  1. Collect every `basicService`/`basicReferer` config bean (id -> group)
 *     from both XML (`<motan:basicService>`/`<motan:basicReferer>`) and
 *     YAML (`uxin.motan.*`).  A basic-config may be defined in a different
 *     file than the service/referer that references it, so all XML + YAML
 *     files are scanned before resolution.
 *  2. For each `<motan:service>`/`<motan:referer>`, resolve its
 *     `basicService`/`basicReferer` ref to a group via the config map.
 *     Unresolved refs fall back to the starter default `motan-ulive-rpc`
 *     at reduced confidence.
 */

import { glob } from 'glob';
import { createIgnoreFilter } from '../../../../config/ignore-service.js';
import { readSafe } from '../fs-utils.js';
import { parseMotanXml } from './xml-parser.js';
import { parseMotanYaml } from './yaml-resolver.js';
import type { MotanContract, MotanBasicConfig } from './types.js';

/** Default group from `motan-spring-boot-starter` (`MotanBasicAutoConfiguration`). */
export const MOTAN_DEFAULT_GROUP = 'motan-ulive-rpc';

/** Spring XML files that may carry `<motan:*>` elements. */
export const MOTAN_XML_GLOB = ['**/spring/**/*.xml', '**/spring-*.xml'];

/** Spring Boot YAML files that may carry `uxin.motan.*`. */
export const MOTAN_YAML_GLOB = ['**/bootstrap-*.{yml,yaml}', '**/application*.{yml,yaml}'];

export interface ResolvedMotanContract extends MotanContract {
  /** Resolved group (real or default fallback). */
  group: string;
  /** 1.0 when group resolved from a real config, 0.7 for default fallback. */
  confidence: number;
  /** Where the group was resolved from. */
  groupSource: 'xml' | 'yaml' | 'default';
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/');
}

/**
 * Scan a repo's XML + YAML config and return motan contracts with resolved
 * groups.  Honour `.gitnexusignore` / `.gitignore` via the shared
 * IgnoreService (mirrors the grpc-extractor source scan).
 */
export async function resolveMotanContracts(repoPath: string): Promise<ResolvedMotanContract[]> {
  const ignoreFilter = await createIgnoreFilter(repoPath);

  const [xmlFiles, yamlFiles] = await Promise.all([
    glob(MOTAN_XML_GLOB, { cwd: repoPath, ignore: ignoreFilter, nodir: true }),
    glob(MOTAN_YAML_GLOB, { cwd: repoPath, ignore: ignoreFilter, nodir: true }),
  ]);

  const configs = new Map<string, MotanBasicConfig>();
  const contracts: MotanContract[] = [];

  // ── Pass 1a: XML - basicConfig definitions + raw contracts ───────
  for (const rel of xmlFiles) {
    const content = readSafe(repoPath, rel);
    if (!content) continue;
    // Cheap pre-filter: skip XML files with no motan namespace usage.
    if (!content.includes('api.weibo.com/schema/motan') && !content.includes('<motan:')) continue;
    const { contracts: c, configs: cfg } = parseMotanXml(content, normalizeRel(rel));
    contracts.push(...c);
    for (const config of cfg) {
      if (config.group) configs.set(config.id, config);
    }
  }

  // ── Pass 1b: YAML - basicConfig definitions from uxin.motan.* ─────
  for (const rel of yamlFiles) {
    const content = readSafe(repoPath, rel);
    if (!content) continue;
    if (!content.includes('uxin') || !content.includes('motan')) continue;
    const cfg = parseMotanYaml(content);
    for (const config of cfg) {
      if (config.group) configs.set(config.id, config);
    }
  }

  // ── Pass 2: resolve each contract's group from the config map ─────
  const resolved: ResolvedMotanContract[] = [];
  for (const c of contracts) {
    const config = configs.get(c.basicRef);
    if (config && config.group) {
      resolved.push({
        ...c,
        group: config.group,
        confidence: 1.0,
        groupSource: config.source,
        // Inline `export` on the service/referer takes precedence; otherwise
        // fall back to the basic-config's `export` (where it usually lives).
        export: c.export ?? config.export,
      });
    } else {
      resolved.push({ ...c, group: MOTAN_DEFAULT_GROUP, confidence: 0.7, groupSource: 'default' });
    }
  }

  return resolved;
}