/**
 * Centralized timing constants — 新架构 §11.5.
 * All timeout / interval / buffer values live here so timing tuning happens
 * in one place. Adjust here, not scattered across routes.
 */

/** §1.1 — Leader lock holder's maximum hold time before forced release. */
export const LEADER_LOCK_TIMEOUT_MS = 10_000;

/** §1.1 — Follower's max wait before abandoning and re-trying the lock. */
export const FOLLOWER_WAIT_TIMEOUT_MS = 15_000;

/** §1.1 — Jitter to spread leader election spawn attempts. */
export const SPAWN_JITTER_MS = 500;

/** §1.1 — Maximum number of follower's lock re-acquisition attempts. */
export const FOLLOWER_RETRY_MAX = 3;

/** §1.1 — Follower 重抢锁时的退避基值 (每轮 ×2, 封顶 LEADER_LOCK_TIMEOUT_MS). */
export const FOLLOWER_BACKOFF_MS = 1_000;

/** §5.2 — Soft floor for RECOVERING; can early-exit if all sessions re-reported. */
export const RECOVERING_SOFT_MIN_MS = 2_000;

/** §5.2 — Hard ceiling for RECOVERING; READY forced even if reports incomplete. */
export const RECOVERING_HARD_MAX_MS = 15_000;

/** §7 — Full sync period (also acts as heartbeat). */
export const SYNC_INTERVAL_MS = 30_000;

/** §7.1 — Instance-level heartbeat timeout (allows 2 missed syncs). */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** §4.4 — Session-level liveness lease TTL (refreshed periodically). */
export const LEASE_TTL_MS = 15_000;

/** §4.4 — Lease renew interval (LEASE_TTL / 3 leaves 3× safety margin). */
export const LEASE_RENEW_INTERVAL_MS = 5_000;

/** §3.3 — bind probe retry count for transient errors (EADDRINUSE gives up immediately). */
export const BIND_PROBE_RETRY = 3;

/** §3.3 — backoff between bind probe retries for transient errors. */
export const BIND_PROBE_BACKOFF_MS = 50;

/** §3.5 — UI runtime `net.connect` probe timeout (longer = false "stopped" state). */
export const RUNTIME_PROBE_TIMEOUT_MS = 300;

/** §7.3 — SSE event ring buffer size for Last-Event-ID replay. */
export const SSE_REPLAY_BUFFER = 256;

/** §11.4 — Default N (number of port keys per session). Pulled from PORT_KEYS_DEFAULT at call sites. */
export const HEARTBEAT_PERSIST_INTERVAL_MS = 5_000;

/** §2 — Daemon protocol version string. Semantic version; AgentDock only
 * compares the major version (bump on breaking change). */
export const PROTOCOL_VERSION = "1";
export const PROTOCOL_VERSION_MAJOR = 1;
