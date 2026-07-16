/**
 * Shared types for the motan-extractor.
 *
 * Motan (Weibo RPC) contracts are declared exclusively in Spring XML files
 * using the `motan:` namespace (`http://api.weibo.com/schema/motan`).
 * There are zero annotation-based providers/consumers in practice.
 *
 * Identity model: (interface FQN, group).  The `group` is essential for
 * disambiguation — the same interface consumed under different groups
 * targets different provider clusters.  `version` is never set anywhere
 * and `protocol` is always the default `motan`.
 */

export type MotanRole = 'provider' | 'consumer';

/**
 * One raw motan contract extracted from a `<motan:service>` or
 * `<motan:referer>` element.  The `group` is NOT resolved yet at this
 * stage — it comes from the referenced `basicService`/`basicReferer`
 * config bean (which may be defined in another XML file or in YAML).
 */
export interface MotanContract {
  /** Interface FQN, e.g. `"com.uxin.zb.room.service.RoomService"`. */
  interface: string;
  /** Provider (`<motan:service>`) or consumer (`<motan:referer>`). */
  role: MotanRole;
  /** The `basicService` or `basicReferer` config bean id. */
  basicRef: string;
  /** Optional inline `export` value (provider side, e.g. `"uxzbMotan:8002"`). */
  export?: string;
  /** Optional inline `requestTimeout`. */
  requestTimeout?: string;
  /** Relative file path of the XML source within the repo. */
  filePath: string;
}

/**
 * One resolved basic-config bean definition gathered from either
 * `<motan:basicService>`/`<motan:basicReferer>` in XML or
 * `uxin.motan.*` in YAML.
 */
export interface MotanBasicConfig {
  /** Config bean id (e.g. `"serviceBasicConfig"`, `"roomBasicRefer"`). */
  id: string;
  /** The resolved `group` value. */
  group: string;
  /** Optional `export` value. */
  export?: string;
  /** Where this config was sourced from. */
  source: 'xml' | 'yaml';
}