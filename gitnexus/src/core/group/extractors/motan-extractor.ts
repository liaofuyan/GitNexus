import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { resolveMotanContracts } from './motan-patterns/index.js';

/**
 * Motan (Weibo RPC) contract extractor.
 *
 * Motan providers/consumers are declared in Spring XML
 * (`<motan:service>`/`<motan:referer>`), not as Java annotations.  Group
 * resolution (the load-bearing identity field) is delegated to
 * {@link resolveMotanContracts}, which scans XML + YAML in two passes.
 *
 * Contract id format: `motan::<interfaceFQN>::<group>`.  Provider and
 * consumer for the same (interface, group) emit the same contract id, so
 * `runExactMatch` pairs them directly - no service-wildcard form needed.
 *
 * `symbolUid` Strategy-A resolution: when a `dbExecutor` is available
 * (the normal `group sync` path), each contract's interface FQN is resolved
 * to a real graph `Class`/`Interface` node uid via Cypher.  This lets
 * `group impact` Phase-2 fan out across motan `ContractLink`s - the join
 * (`provider.symbolUid IN $uids`) matches because the contract carries the
 * real graph uid.  When the interface isn't in this repo's graph (it lives
 * in a separate service-api repo or an external dependency JAR), the query
 * returns nothing and we fall back to a synthesized uid (thrift pattern) so
 * the contract is still stored and cross-linked, just without impact fan-out.
 */

const MOTAN_TYPE = 'motan' as const;

function normalizePath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

function motanContractId(iface: string, group: string): string {
  return `motan::${iface}::${group}`;
}

function motanSymbolUid(
  contractId: string,
  role: 'provider' | 'consumer',
  filePath: string,
  symbolName: string,
): string {
  const contractKey = contractId.startsWith('motan::')
    ? contractId.slice('motan::'.length)
    : contractId;
  return ['source-scan::motan', role, contractKey, normalizePath(filePath), symbolName].join('::');
}

/**
 * Resolve real graph symbol uids for a set of interface FQNs via Cypher.
 * Returns a map of `interfaceFQN -> graphNodeUid` for interfaces found in
 * this repo's graph.  The package path (derived from the FQN) filters by
 * `filePath CONTAINS` to disambiguate same-named classes across packages.
 */
async function resolveSymbolUids(
  dbExecutor: CypherExecutor,
  interfaces: string[],
): Promise<Map<string, string>> {
  const uidMap = new Map<string, string>();
  const seen = new Set<string>();
  for (const iface of interfaces) {
    if (seen.has(iface)) continue;
    seen.add(iface);
    const dotIdx = iface.lastIndexOf('.');
    const simpleName = dotIdx >= 0 ? iface.slice(dotIdx + 1) : iface;
    const pkgPath = dotIdx >= 0 ? iface.slice(0, dotIdx).replace(/\./g, '/') : '';
    const params: Record<string, unknown> = { name: simpleName };
    if (pkgPath) params.pkg = pkgPath;
    try {
      const rows = await dbExecutor(
        `MATCH (n)
         WHERE labels(n) IN ['Class','Interface'] AND n.name = $name
           ${pkgPath ? 'AND n.filePath CONTAINS $pkg' : ''}
         RETURN n.id AS uid
         ORDER BY CASE labels(n)[0] WHEN 'Class' THEN 0 WHEN 'Interface' THEN 1 ELSE 2 END
         LIMIT 1`,
        params,
      );
      if (rows.length > 0 && rows[0].uid != null) {
        uidMap.set(iface, String(rows[0].uid));
      }
    } catch {
      // Graph query failed (repo not indexed, schema mismatch, etc.) -
      // fall back to synthesized uid for this interface.
    }
  }
  return uidMap;
}

export class MotanExtractor implements ContractExtractor {
  type = MOTAN_TYPE;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    // Every repo is scanned; the cost is bounded by the glob + content
    // pre-filter finding nothing.  Mirrors grpc/thrift/topic extractors.
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const resolved = await resolveMotanContracts(repoPath);

    // Strategy-A: resolve real graph uids so cross-impact can fan out across
    // motan ContractLinks.  No-op (empty map) when dbExecutor is null (tests).
    const uidMap = dbExecutor
      ? await resolveSymbolUids(dbExecutor, resolved.map((c) => c.interface))
      : new Map<string, string>();

    const out: ExtractedContract[] = [];
    for (const c of resolved) {
      const cid = motanContractId(c.interface, c.group);
      const realUid = uidMap.get(c.interface);
      const symbolUid = realUid ?? motanSymbolUid(cid, c.role, c.filePath, c.interface);
      out.push({
        contractId: cid,
        type: MOTAN_TYPE,
        role: c.role,
        symbolUid,
        symbolRef: { filePath: normalizePath(c.filePath), name: c.interface },
        symbolName: c.interface,
        confidence: c.confidence,
        meta: {
          group: c.group,
          interface: c.interface,
          export: c.export,
          requestTimeout: c.requestTimeout,
          basicRef: c.basicRef,
          groupSource: c.groupSource,
          uidSource: realUid ? 'graph' : 'synthesized',
          extractionStrategy: 'source_scan',
        },
      });
    }

    return this.dedupe(out);
  }

  /**
   * Collapse duplicate declarations of the same (contractId, role, filePath).
   * Keeps the highest-confidence copy - mirrors the grpc-extractor dedupe.
   */
  private dedupe(contracts: ExtractedContract[]): ExtractedContract[] {
    const map = new Map<string, ExtractedContract>();
    for (const c of contracts) {
      const key = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      const existing = map.get(key);
      if (!existing || c.confidence > existing.confidence) {
        map.set(key, c);
      }
    }
    return [...map.values()];
  }
}