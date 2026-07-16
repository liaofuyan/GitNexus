/**
 * Regex-based parser for Spring XML files using the Motan namespace
 * (`http://api.weibo.com/schema/motan`).
 *
 * Motan providers/consumers are declared exclusively via `<motan:service>`
 * and `<motan:referer>` elements - there are zero annotation-based
 * declarations in practice, so no tree-sitter / Java-source scan is needed.
 * The XML structure is predictable Spring config, so a comment-stripping +
 * regex pass is sufficient and avoids pulling in an XML parser dependency.
 */

import type { MotanContract, MotanBasicConfig } from './types.js';

const MOTAN_NS_URI_PATTERN = 'http://api.weibo.com/schema/motan';

export interface MotanXmlParseResult {
  contracts: MotanContract[];
  configs: MotanBasicConfig[];
}

/** Strip XML comments so commented-out elements don't match. */
function stripComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Find the motan namespace prefix declared in this file, e.g. `"motan"`
 * from `xmlns:motan="http://api.weibo.com/schema/motan"`. Returns `null`
 * when the namespace isn't declared AND no literal `<motan:` usage exists.
 */
function findMotanPrefix(content: string): string | null {
  const nsRe = new RegExp(`xmlns:(\\w+)\\s*=\\s*["']${escapeRegex(MOTAN_NS_URI_PATTERN)}["']`);
  const m = content.match(nsRe);
  if (m) return m[1];
  // Fallback: some files use the `motan:` prefix without a local namespace
  // declaration (declared in an imported parent that Spring merges). Accept
  // the literal `motan` prefix only when actually used.
  return content.includes('<motan:') ? 'motan' : null;
}

/** Parse `key="value"` / `key='value'` attribute pairs from a tag body. */
function parseAttrs(attrsStr: string): Map<string, string> {
  const map = new Map<string, string>();
  const attrRe = /(\w+)\s*=\s*(["'])([^"']*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrsStr)) !== null) {
    map.set(m[1], m[3]);
  }
  return map;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse one XML file's motan elements. Returns provider/consumer contracts
 * plus any inline `basicService`/`basicReferer` config definitions.
 * `group` is NOT resolved here - it lives on the referenced basic-config
 * bean, which may be defined in another file or in YAML.
 */
export function parseMotanXml(content: string, filePath: string): MotanXmlParseResult {
  const contracts: MotanContract[] = [];
  const configs: MotanBasicConfig[] = [];

  const cleaned = stripComments(content);
  const prefix = findMotanPrefix(cleaned);
  if (!prefix) return { contracts, configs };

  const elementRe = new RegExp(
    `<${escapeRegex(prefix)}:(service|referer|basicService|basicReferer)\\b([^>]*)>`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = elementRe.exec(cleaned)) !== null) {
    const elementType = match[1];
    const attrs = parseAttrs(match[2]);
    const id = attrs.get('id');
    const iface = attrs.get('interface');

    switch (elementType) {
      case 'service': {
        if (!iface) break;
        contracts.push({
          interface: iface,
          role: 'provider',
          basicRef: attrs.get('basicService') ?? 'serviceBasicConfig',
          export: attrs.get('export'),
          requestTimeout: attrs.get('requestTimeout'),
          filePath,
        });
        break;
      }
      case 'referer': {
        if (!iface) break;
        contracts.push({
          interface: iface,
          role: 'consumer',
          basicRef: attrs.get('basicReferer') ?? 'clientBasicConfig',
          export: attrs.get('export'),
          requestTimeout: attrs.get('requestTimeout'),
          filePath,
        });
        break;
      }
      case 'basicService': {
        if (!id) break;
        configs.push({
          id,
          group: attrs.get('group') ?? '',
          export: attrs.get('export'),
          source: 'xml',
        });
        break;
      }
      case 'basicReferer': {
        if (!id) break;
        configs.push({
          id,
          group: attrs.get('group') ?? '',
          source: 'xml',
        });
        break;
      }
    }
  }

  return { contracts, configs };
}