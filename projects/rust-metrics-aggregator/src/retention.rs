use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::MetricError;
use crate::store::MetricStore;
use crate::types::RetentionPolicy;

/// Returns the current time as milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// Returns `true` if a metric last seen at `last_seen_ms` is stale relative to `now_ms`.
fn is_stale(last_seen_ms: u64, now_ms: u64, ttl_ms: u64) -> bool {
    now_ms - last_seen_ms > ttl_ms
}

/// A background retention manager that periodically evicts stale metrics from a store.
#[derive(Debug)]
pub struct RetentionManager {
    store: MetricStore,
    policy: RetentionPolicy,
    /// Accumulated count of pruned entries across all sweeps.
    total_pruned: Arc<Mutex<u64>>,
}

impl RetentionManager {
    /// Creates a new `RetentionManager` for the given store and policy.
    pub fn new(store: MetricStore, policy: RetentionPolicy) -> Self {
        RetentionManager {
            store,
            policy,
            total_pruned: Arc::new(Mutex::new(0)),
        }
    }

    /// Runs a single sweep, evicting all metrics that are stale per the policy.
    ///
    /// Returns the number of entries evicted in this sweep.
    pub fn sweep(&self) -> Result<usize, MetricError> {
        let now = now_ms();
        let stale_count = self.store.prune_stale_policy(now, &self.policy)?;
        if stale_count > 0 {
            let mut total = self.total_pruned.lock().unwrap();
            *total += stale_count as u64;
        }
        Ok(stale_count)
    }

    /// Returns the total number of entries pruned across all sweeps since this manager was created.
    pub fn total_pruned(&self) -> u64 {
        *self.total_pruned.lock().unwrap()
    }
}

/// Statistics about the current state of the metric store's retention.
#[derive(Debug, Clone)]
pub struct RetentionStats {
    pub total_metrics: usize,
    pub stale_metrics: usize,
    pub active_metrics: usize,
    pub oldest_last_seen_ms: Option<u64>,
    pub newest_last_seen_ms: Option<u64>,
}

impl RetentionStats {
    /// Computes retention statistics from the current store state.
    pub fn compute(store: &MetricStore, now: u64, ttl_ms: u64) -> Result<Self, MetricError> {
        store.read_entries(|entries| {
            let total_metrics = entries.len();
            let mut stale_count = 0usize;
            let mut oldest: Option<u64> = None;
            let mut newest: Option<u64> = None;

            for (_name, &last_seen) in entries {
                if is_stale(last_seen, now, ttl_ms) {
                    stale_count += 1;
                }
                oldest = Some(oldest.map_or(last_seen, |o: u64| o.min(last_seen)));
                newest = Some(newest.map_or(last_seen, |n: u64| n.max(last_seen)));
            }

            RetentionStats {
                total_metrics,
                stale_metrics: stale_count,
                active_metrics: total_metrics.saturating_sub(stale_count),
                oldest_last_seen_ms: oldest,
                newest_last_seen_ms: newest,
            }
        })
    }
}
