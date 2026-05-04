use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use crate::error::MetricError;
use crate::histogram::{Histogram, HistogramConfig};
use crate::types::{Labels, MetricId, MetricKind, RetentionPolicy, StoreConfig};

/// Internal representation of a single registered metric.
#[derive(Debug)]
pub(crate) struct MetricEntry {
    pub id: MetricId,
    pub kind: MetricKind,
    pub name: String,
    pub labels: Labels,
    /// Monotonically increasing counter total (used for Counter kind).
    pub total: u64,
    /// Current gauge value (used for Gauge kind).
    pub gauge_value: f64,
    /// Histogram for distribution metrics (used for Histogram kind).
    pub histogram: Option<Histogram>,
    /// Last time this metric received an update, in milliseconds since epoch.
    pub last_seen_ms: u64,
}

impl MetricEntry {
    pub fn new(id: MetricId, kind: MetricKind, name: String, labels: Labels, now_ms: u64) -> Self {
        let histogram = if kind == MetricKind::Histogram {
            Some(Histogram::new(HistogramConfig::default()))
        } else {
            None
        };
        MetricEntry {
            id,
            kind,
            name,
            labels,
            total: 0,
            gauge_value: 0.0,
            histogram,
            last_seen_ms: now_ms,
        }
    }
}

#[derive(Debug, Default)]
struct StoreInner {
    name_to_id: HashMap<String, MetricId>,
    entries: HashMap<MetricId, MetricEntry>,
}

/// A thread-safe store for all registered metrics.
///
/// Callers record observations by name; the store handles ID allocation and
/// kind enforcement. All internal state is protected by a single `RwLock`.
#[derive(Debug, Clone)]
pub struct MetricStore {
    inner: Arc<RwLock<StoreInner>>,
    next_id: Arc<AtomicU64>,
    config: StoreConfig,
}

impl MetricStore {
    /// Creates a new `MetricStore` with the given configuration.
    pub fn new(config: StoreConfig) -> Self {
        MetricStore {
            inner: Arc::new(RwLock::new(StoreInner::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            config,
        }
    }

    /// Creates a new `MetricStore` with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(StoreConfig::default())
    }

    /// Returns the configuration this store was created with.
    pub fn config(&self) -> &StoreConfig {
        &self.config
    }

    /// Looks up an existing metric by name, or inserts a new one.
    ///
    /// Returns an error if the name is already registered under a different kind.
    fn get_or_create(
        &self,
        name: &str,
        kind: MetricKind,
        labels: Labels,
        now_ms: u64,
    ) -> Result<MetricId, MetricError> {
        {
            let guard = self.inner.read()?;
            if let Some(&id) = guard.name_to_id.get(name) {
                let entry = &guard.entries[&id];
                if entry.kind != kind {
                    return Err(MetricError::KindMismatch {
                        name: name.to_string(),
                        expected: entry.kind.as_str(),
                        got: kind.as_str(),
                    });
                }
                return Ok(id);
            }
        }

        let mut guard = self.inner.write()?;
        let id = MetricId(self.next_id.fetch_add(1, Ordering::Relaxed));
        guard.name_to_id.insert(name.to_string(), id);
        guard
            .entries
            .insert(id, MetricEntry::new(id, kind, name.to_string(), labels, now_ms));
        Ok(id)
    }

    /// Records a delta increment to a counter metric.
    ///
    /// The counter is identified by `name`. If this is the first observation,
    /// the counter is registered automatically. The `delta` value is the
    /// number of events to add to the running total.
    pub fn record_counter(
        &self,
        name: &str,
        delta: i64,
        labels: Labels,
        now_ms: u64,
    ) -> Result<(), MetricError> {
        let id = self.get_or_create(name, MetricKind::Counter, labels, now_ms)?;
        let mut guard = self.inner.write()?;
        if let Some(entry) = guard.entries.get_mut(&id) {
            entry.total = entry.total.wrapping_add(delta as u64);
            entry.last_seen_ms = now_ms;
        }
        Ok(())
    }

    /// Sets the current value of a gauge metric.
    pub fn record_gauge(
        &self,
        name: &str,
        value: f64,
        labels: Labels,
        now_ms: u64,
    ) -> Result<(), MetricError> {
        let id = self.get_or_create(name, MetricKind::Gauge, labels, now_ms)?;
        let mut guard = self.inner.write()?;
        if let Some(entry) = guard.entries.get_mut(&id) {
            entry.gauge_value = value;
            entry.last_seen_ms = now_ms;
        }
        Ok(())
    }

    /// Records a single observation to a histogram metric.
    pub fn record_histogram(
        &self,
        name: &str,
        value: f64,
        labels: Labels,
        now_ms: u64,
    ) -> Result<(), MetricError> {
        let id = self.get_or_create(name, MetricKind::Histogram, labels, now_ms)?;
        // Histogram observation can happen under a read lock because the Histogram
        // type is internally synchronized via its own Mutex.
        let guard = self.inner.read()?;
        if let Some(entry) = guard.entries.get(&id) {
            if let Some(hist) = &entry.histogram {
                hist.observe(value);
            }
        }
        drop(guard);
        // Update last_seen_ms under write lock.
        let mut guard = self.inner.write()?;
        if let Some(entry) = guard.entries.get_mut(&id) {
            entry.last_seen_ms = now_ms;
        }
        Ok(())
    }

    /// Returns the current total for a counter metric, or `None` if not found.
    pub fn get_counter(&self, name: &str) -> Result<Option<u64>, MetricError> {
        let guard = self.inner.read()?;
        match guard.name_to_id.get(name) {
            None => Ok(None),
            Some(&id) => Ok(guard.entries.get(&id).map(|e| e.total)),
        }
    }

    /// Returns the current value of a gauge metric, or `None` if not found.
    pub fn get_gauge(&self, name: &str) -> Result<Option<f64>, MetricError> {
        let guard = self.inner.read()?;
        match guard.name_to_id.get(name) {
            None => Ok(None),
            Some(&id) => Ok(guard.entries.get(&id).map(|e| e.gauge_value)),
        }
    }

    /// Provides scoped read access to the `Histogram` for the named metric.
    ///
    /// The closure is invoked while the read lock is held. Returns `None` if
    /// the metric does not exist or is not a histogram.
    pub fn with_histogram<F, R>(&self, name: &str, f: F) -> Result<Option<R>, MetricError>
    where
        F: FnOnce(&Histogram) -> R,
    {
        let guard = self.inner.read()?;
        match guard.name_to_id.get(name) {
            None => Ok(None),
            Some(&id) => Ok(guard
                .entries
                .get(&id)
                .and_then(|e| e.histogram.as_ref())
                .map(f)),
        }
    }

    /// Returns a list of all currently registered metric names and kinds.
    pub fn list_metrics(&self) -> Result<Vec<(String, MetricKind)>, MetricError> {
        let guard = self.inner.read()?;
        Ok(guard
            .entries
            .values()
            .map(|e| (e.name.clone(), e.kind))
            .collect())
    }

    /// Removes all entries that have not been updated within the configured TTL.
    pub fn prune_stale(&self, now_ms: u64) -> Result<usize, MetricError> {
        let ttl_ms = self.config.ttl_ms;
        let mut guard = self.inner.write()?;
        let stale_ids: Vec<MetricId> = guard
            .entries
            .iter()
            .filter(|(_, e)| now_ms - e.last_seen_ms > ttl_ms)
            .map(|(&id, _)| id)
            .collect();

        let count = stale_ids.len();
        for id in &stale_ids {
            if let Some(entry) = guard.entries.remove(id) {
                guard.name_to_id.remove(&entry.name);
            }
        }
        Ok(count)
    }

    /// Removes entries that are stale according to the given `RetentionPolicy`.
    ///
    /// Unlike `prune_stale`, this method respects pinned metric names.
    pub fn prune_stale_policy(
        &self,
        now_ms: u64,
        policy: &RetentionPolicy,
    ) -> Result<usize, MetricError> {
        let mut guard = self.inner.write()?;
        let stale_ids: Vec<MetricId> = guard
            .entries
            .iter()
            .filter(|(_, e)| policy.should_evict(&e.name, e.last_seen_ms, now_ms))
            .map(|(&id, _)| id)
            .collect();

        let count = stale_ids.len();
        for id in &stale_ids {
            if let Some(entry) = guard.entries.remove(id) {
                guard.name_to_id.remove(&entry.name);
            }
        }
        Ok(count)
    }

    /// Returns the number of registered metrics.
    pub fn len(&self) -> Result<usize, MetricError> {
        Ok(self.inner.read()?.entries.len())
    }

    pub fn is_empty(&self) -> Result<bool, MetricError> {
        Ok(self.inner.read()?.entries.is_empty())
    }

    /// Provides raw read access to all entries via a closure.
    ///
    /// The closure receives a map of `(name: &str, last_seen_ms: u64)` pairs,
    /// which is sufficient for retention statistics without exposing full entry types.
    pub(crate) fn read_entries<F, R>(&self, f: F) -> Result<R, MetricError>
    where
        F: FnOnce(&HashMap<&str, u64>) -> R,
    {
        let guard = self.inner.read()?;
        let slim: HashMap<&str, u64> = guard
            .entries
            .values()
            .map(|e| (e.name.as_str(), e.last_seen_ms))
            .collect();
        Ok(f(&slim))
    }

    /// Provides full read access to all entries for the exporter.
    pub(crate) fn read_all_entries<F, R>(&self, f: F) -> Result<R, MetricError>
    where
        F: FnOnce(&HashMap<MetricId, MetricEntry>) -> R,
    {
        let guard = self.inner.read()?;
        Ok(f(&guard.entries))
    }
}
