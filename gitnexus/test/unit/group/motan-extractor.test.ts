import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { MotanExtractor } from '../../../src/core/group/extractors/motan-extractor.js';
import { buildProviderIndex, runExactMatch } from '../../../src/core/group/matching.js';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import type { RepoHandle, StoredContract } from '../../../src/core/group/types.js';

/**
 * Motan extractor tests.  No tree-sitter mock needed - Motan contracts are
 * parsed from Spring XML via regex, not from Java source.  Fixtures mirror
 * the real config style in /data/repos/java (XML `<motan:service>` /
 * `<motan:referer>` + inline `<motan:basicService>` / `<motan:basicReferer>`
 * or YAML `uxin.motan.*`).
 */

const ROOM_IFACE = 'com.uxin.zb.room.service.RoomService';
const ROOM_GROUP = 'motan-room-rpc';

function xmlHeader(prefix = 'motan'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:${prefix}="http://api.weibo.com/schema/motan"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;
}

describe('MotanExtractor', () => {
  let tmpDir: string;
  let extractor: MotanExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-motan-'));
    extractor = new MotanExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  it('test_extract_provider_with_inline_basicService_returns_provider_contract', async () => {
    writeFile(
      'src/main/resources/spring/rpc-room-service.xml',
      `${xmlHeader()}
  <motan:basicService id="serviceBasicConfig" group="${ROOM_GROUP}" export="uxzbMotan:8002"/>
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].contractId).toBe(`motan::${ROOM_IFACE}::${ROOM_GROUP}`);
    expect(providers[0].type).toBe('motan');
    expect(providers[0].confidence).toBe(1.0);
    expect(providers[0].symbolRef.name).toBe(ROOM_IFACE);
    expect(providers[0].symbolRef.filePath).toBe('src/main/resources/spring/rpc-room-service.xml');
    expect(providers[0].meta.group).toBe(ROOM_GROUP);
    expect(providers[0].meta.groupSource).toBe('xml');
    expect(providers[0].meta.export).toBe('uxzbMotan:8002');
  });

  it('test_extract_consumer_with_inline_basicReferer_returns_consumer_contract', async () => {
    writeFile(
      'src/main/resources/spring/rpc-room-client.xml',
      `${xmlHeader()}
  <motan:basicReferer id="roomBasicRefer" group="${ROOM_GROUP}"/>
  <motan:referer id="roomService" interface="${ROOM_IFACE}" basicReferer="roomBasicRefer" check="false"/>
</beans>`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts.filter((c) => c.role === 'consumer');

    expect(consumers).toHaveLength(1);
    expect(consumers[0].contractId).toBe(`motan::${ROOM_IFACE}::${ROOM_GROUP}`);
    expect(consumers[0].meta.group).toBe(ROOM_GROUP);
    expect(consumers[0].meta.basicRef).toBe('roomBasicRefer');
  });

  it('test_extract_group_resolved_from_yaml_basicService', async () => {
    // Service references the default bean name `serviceBasicConfig`, whose
    // group lives in YAML (uxin.motan.server) - the motan-spring-boot-starter
    // pattern used by room-server/room-portal.
    writeFile(
      'src/main/resources/spring/rpc-service.xml',
      `${xmlHeader()}
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );
    writeFile(
      'src/main/resources/bootstrap-dev01.yml',
      `uxin:
  motan:
    server:
      group: ${ROOM_GROUP}
      export: uxzbMotan:8002
`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].meta.group).toBe(ROOM_GROUP);
    expect(providers[0].meta.groupSource).toBe('yaml');
    expect(providers[0].confidence).toBe(1.0);
  });

  it('test_extract_group_resolved_from_yaml_named_basicReferer', async () => {
    writeFile(
      'src/main/resources/spring/rpc-client.xml',
      `${xmlHeader()}
  <motan:referer id="roomService" interface="${ROOM_IFACE}" basicReferer="roomBasicRefer"/>
</beans>`,
    );
    writeFile(
      'src/main/resources/bootstrap-dev01.yml',
      `uxin:
  motan:
    basic-referers:
      roomBasicRefer:
        group: ${ROOM_GROUP}
`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts.filter((c) => c.role === 'consumer');

    expect(consumers).toHaveLength(1);
    expect(consumers[0].meta.group).toBe(ROOM_GROUP);
    expect(consumers[0].meta.groupSource).toBe('yaml');
  });

  it('test_extract_unresolved_basicRef_falls_back_to_default_group', async () => {
    // basicService references a config that is defined nowhere (neither XML
    // nor YAML).  Should fall back to the starter default `motan-ulive-rpc`
    // at reduced confidence.
    writeFile(
      'src/main/resources/spring/rpc-service.xml',
      `${xmlHeader()}
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="nonExistentConfig"/>
</beans>`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].meta.group).toBe('motan-ulive-rpc');
    expect(providers[0].meta.groupSource).toBe('default');
    expect(providers[0].confidence).toBe(0.7);
  });

  it('test_extract_handles_nonstandard_namespace_prefix', async () => {
    // Some files declare the motan namespace under a different prefix (e.g. `m`).
    writeFile(
      'src/main/resources/spring/rpc-service.xml',
      `${xmlHeader('m')}
  <m:basicService id="serviceBasicConfig" group="${ROOM_GROUP}"/>
  <m:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].contractId).toBe(`motan::${ROOM_IFACE}::${ROOM_GROUP}`);
  });

  it('test_extract_strips_xml_comments', async () => {
    writeFile(
      'src/main/resources/spring/rpc-service.xml',
      `${xmlHeader()}
  <!-- <motan:service interface="com.fake.Removed" ref="x" basicService="serviceBasicConfig"/> -->
  <motan:basicService id="serviceBasicConfig" group="${ROOM_GROUP}"/>
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts).toHaveLength(1);
    expect(contracts[0].symbolName).toBe(ROOM_IFACE);
  });

  it('test_extract_ignores_xml_without_motan_namespace', async () => {
    writeFile(
      'src/main/resources/spring/other.xml',
      `<?xml version="1.0"?>
<beans xmlns="http://www.springframework.org/schema/beans">
  <bean id="foo" class="com.example.Foo"/>
</beans>`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts).toHaveLength(0);
  });

  it('test_e2e_provider_consumer_same_group_creates_exact_cross_link', async () => {
    // Two-repo fixture: room-server (provider) + room-portal (consumer),
    // both keyed on (RoomService, motan-room-rpc).  runExactMatch should
    // pair them with matchType 'exact'.
    const providerDir = path.join(tmpDir, 'room-server');
    const consumerDir = path.join(tmpDir, 'room-portal');
    fs.mkdirSync(path.join(providerDir, 'src/main/resources/spring'), { recursive: true });
    fs.mkdirSync(path.join(consumerDir, 'src/main/resources/spring'), { recursive: true });

    fs.writeFileSync(
      path.join(providerDir, 'src/main/resources/spring/rpc-room-service.xml'),
      `${xmlHeader()}
  <motan:basicService id="serviceBasicConfig" group="${ROOM_GROUP}" export="uxzbMotan:8002"/>
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );
    fs.writeFileSync(
      path.join(consumerDir, 'src/main/resources/spring/rpc-room-client.xml'),
      `${xmlHeader()}
  <motan:basicReferer id="roomBasicRefer" group="${ROOM_GROUP}"/>
  <motan:referer id="roomService" interface="${ROOM_IFACE}" basicReferer="roomBasicRefer" check="false"/>
</beans>`,
    );

    const providerExtracted = await extractor.extract(null, providerDir, makeRepo(providerDir));
    const consumerExtracted = await extractor.extract(null, consumerDir, makeRepo(consumerDir));

    const stored: StoredContract[] = [
      ...providerExtracted.map((c) => ({ ...c, repo: 'room-server' })),
      ...consumerExtracted.map((c) => ({ ...c, repo: 'room-portal' })),
    ];

    const providerIndex = buildProviderIndex(stored);
    const result = runExactMatch(stored, providerIndex);

    expect(result.matched).toHaveLength(1);
    const cross = result.matched[0];
    expect(cross.contractId).toBe(`motan::${ROOM_IFACE}::${ROOM_GROUP}`);
    expect(cross.matchType).toBe('exact');
    expect(cross.from.repo).toBe('room-portal'); // consumer
    expect(cross.to.repo).toBe('room-server'); // provider
  });

  it('test_e2e_different_groups_do_not_match', async () => {
    // Same interface, different groups -> different contract ids -> no match.
    const providerDir = path.join(tmpDir, 'room-server');
    const consumerDir = path.join(tmpDir, 'ypzb');
    fs.mkdirSync(path.join(providerDir, 'src/main/resources/spring'), { recursive: true });
    fs.mkdirSync(path.join(consumerDir, 'src/main/resources/spring'), { recursive: true });

    fs.writeFileSync(
      path.join(providerDir, 'src/main/resources/spring/rpc-service.xml'),
      `${xmlHeader()}
  <motan:basicService id="serviceBasicConfig" group="motan-room-rpc"/>
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );
    // Consumer under a DIFFERENT group (motan-ulive-rpc) - targets a different
    // provider cluster, must NOT cross-link to the motan-room-rpc provider.
    fs.writeFileSync(
      path.join(consumerDir, 'src/main/resources/spring/rpc-client.xml'),
      `${xmlHeader()}
  <motan:basicReferer id="clientBasicConfig" group="motan-ulive-rpc"/>
  <motan:referer id="roomService" interface="${ROOM_IFACE}" basicReferer="clientBasicConfig"/>
</beans>`,
    );

    const providerExtracted = await extractor.extract(null, providerDir, makeRepo(providerDir));
    const consumerExtracted = await extractor.extract(null, consumerDir, makeRepo(consumerDir));

    const stored: StoredContract[] = [
      ...providerExtracted.map((c) => ({ ...c, repo: 'room-server' })),
      ...consumerExtracted.map((c) => ({ ...c, repo: 'ypzb' })),
    ];

    const result = runExactMatch(stored);
    expect(result.matched).toHaveLength(0);
  });

  it('test_extract_resolves_real_graph_uid_when_dbExecutor_available', async () => {
    writeFile(
      'src/main/resources/spring/rpc-service.xml',
      `${xmlHeader()}
  <motan:basicService id="serviceBasicConfig" group="${ROOM_GROUP}"/>
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );

    // Mock Cypher executor: returns a real graph uid for RoomService.
    const mockExecutor: CypherExecutor = async (_q, params) => {
      if (params?.name === 'RoomService') {
        return [{ uid: 'graph::room-server::Interface::RoomService' }];
      }
      return [];
    };

    const contracts = await extractor.extract(mockExecutor, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].symbolUid).toBe('graph::room-server::Interface::RoomService');
    expect(providers[0].meta.uidSource).toBe('graph');
  });

  it('test_extract_falls_back_to_synthesized_uid_when_interface_not_in_graph', async () => {
    writeFile(
      'src/main/resources/spring/rpc-service.xml',
      `${xmlHeader()}
  <motan:basicService id="serviceBasicConfig" group="${ROOM_GROUP}"/>
  <motan:service interface="${ROOM_IFACE}" ref="roomService" basicService="serviceBasicConfig"/>
</beans>`,
    );

    // Mock executor returns nothing - interface lives in another repo/JAR.
    const mockExecutor: CypherExecutor = async () => [];

    const contracts = await extractor.extract(mockExecutor, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    expect(providers).toHaveLength(1);
    expect(providers[0].symbolUid).toContain('source-scan::motan');
    expect(providers[0].meta.uidSource).toBe('synthesized');
  });
});