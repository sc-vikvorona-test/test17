use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};

/// Opaque identifier for a registered metric.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MetricId(pub(crate) u64);

/// The kind of a metric, determining how values are interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetricKind {
    /// A monotonically increasing counter (e.g. request count).
    Counter,
    /// A point-in-time gauge (e.g. current queue depth).
    Gauge,
    /// A distribution of observed values (e.g. request latency).
    Histogram,
}

impl MetricKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MetricKind::Counter => "counter",
            MetricKind::Gauge => "gauge",
            MetricKind::Histogram => "histogram",
        }
    }
}

/// Labels attached to a metric for dimensional querying.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Labels(pub HashMap<String, String>);

impl Labels {
    pub fn new() -> Self {
        Labels(HashMap::new())
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.0.insert(key.into(), value.into());
        self
    }

    /// Render labels as a Prometheus-compatible label set string, e.g. `{env="prod",svc="api"}`.
    pub fn to_prometheus_string(&self) -> String {
        if self.0.is_empty() {
            return String::new();
        }
        let mut pairs: Vec<_> = self.0.iter().collect();
        pairs.sort_by_key(|(k, _)| k.as_str());
        let inner: Vec<String> = pairs
            .into_iter()
            .map(|(k, v)| format!(r#"{}="{}""#, k, v.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect();
        format!("{{{}}}", inner.join(","))
    }
}

/// A snapshot of a counter metric at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CounterSnapshot {
    pub id: MetricId,
    pub name: String,
    pub labels: Labels,
    pub total: u64,
    pub last_seen_ms: u64,
}

/// A snapshot of a gauge metric at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GaugeSnapshot {
    pub id: MetricId,
    pub name: String,
    pub labels: Labels,
    pub value: f64,
    pub last_seen_ms: u64,
}

/// A snapshot of a histogram metric, including precomputed summary statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistogramSnapshot {
    pub id: MetricId,
    pub name: String,
    pub labels: Labels,
    pub count: u64,
    pub sum: f64,
    pub min: f64,
    pub max: f64,
    pub p50: Option<f64>,
    pub p90: Option<f64>,
    pub p99: Option<f64>,
    pub last_seen_ms: u64,
}

/// A combined metric snapshot for export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MetricSnapshot {
    Counter(CounterSnapshot),
    Gauge(GaugeSnapshot),
    Histogram(HistogramSnapshot),
}

impl MetricSnapshot {
    pub fn name(&self) -> &str {
        match self {
            MetricSnapshot::Counter(s) => &s.name,
            MetricSnapshot::Gauge(s) => &s.name,
            MetricSnapshot::Histogram(s) => &s.name,
        }
    }

    pub fn labels(&self) -> &Labels {
        match self {
            MetricSnapshot::Counter(s) => &s.labels,
            MetricSnapshot::Gauge(s) => &s.labels,
            MetricSnapshot::Histogram(s) => &s.labels,
        }
    }

    pub fn last_seen_ms(&self) -> u64 {
        match self {
            MetricSnapshot::Counter(s) => s.last_seen_ms,
            MetricSnapshot::Gauge(s) => s.last_seen_ms,
            MetricSnapshot::Histogram(s) => s.last_seen_ms,
        }
    }
}

/// Configuration for a `MetricStore`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreConfig {
    /// Number of buckets in the sliding window.
    pub window_buckets: usize,
    /// Duration of each window bucket in milliseconds.
    pub bucket_duration_ms: u64,
    /// Time-to-live for inactive metrics, in milliseconds.
    pub ttl_ms: u64,
}

impl Default for StoreConfig {
    fn default() -> Self {
        StoreConfig {
            window_buckets: 60,
            bucket_duration_ms: 1_000,
            ttl_ms: 300_000, // 5 minutes
        }
    }
}

/// Policy controlling when a metric is considered stale and eligible for removal.
#[derive(Debug, Clone)]
pub struct RetentionPolicy {
    /// Metrics that have not received an update for this duration will be pruned.
    pub ttl_ms: u64,
    /// Metrics in this set are exempt from TTL pruning regardless of activity.
    pub pinned_names: HashSet<String>,
}

impl RetentionPolicy {
    /// Creates a policy with the given TTL and no pinned names.
    pub fn with_ttl(ttl_ms: u64) -> Self {
        RetentionPolicy {
            ttl_ms,
            pinned_names: HashSet::new(),
        }
    }

    /// Pins a metric name so it is never pruned by TTL.
    pub fn pin(mut self, name: impl Into<String>) -> Self {
        self.pinned_names.insert(name.into());
        self
    }

    /// Returns `true` if a metric should be evicted given its name and last-seen time.
    pub fn should_evict(&self, name: &str, last_seen_ms: u64, now_ms: u64) -> bool {
        if self.pinned_names.contains(name) {
            return false;
        }
        now_ms - last_seen_ms > self.ttl_ms
    }
}
