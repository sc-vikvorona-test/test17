//! # rust-metrics-aggregator
//!
//! A time-series metrics collection and aggregation library.
//!
//! Supports:
//! - **Counters** — monotonically increasing event counts.
//! - **Gauges** — point-in-time scalar values.
//! - **Histograms** — distributions of observed values with percentile queries.
//! - **Sliding windows** — temporal aggregation over configurable time buckets.
//! - **Retention** — TTL-based eviction of inactive metrics.
//! - **Export** — Prometheus text format and JSON serialization.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use metrics_aggregator::{MetricStore, StoreConfig, Labels};
//! use metrics_aggregator::retention::now_ms;
//!
//! let store = MetricStore::with_defaults();
//! let now = now_ms();
//!
//! store.record_counter("requests_total", 1, Labels::new(), now).unwrap();
//! store.record_gauge("queue_depth", 42.0, Labels::new(), now).unwrap();
//! store.record_histogram("latency_ms", 13.5, Labels::new(), now).unwrap();
//!
//! let prom = metrics_aggregator::export::to_prometheus(&store).unwrap();
//! println!("{}", prom);
//! ```

pub mod counter;
pub mod error;
pub mod export;
pub mod histogram;
pub mod retention;
pub mod store;
pub mod types;
pub mod window;

// Re-export the most commonly used items at the crate root for convenience.
pub use error::MetricError;
pub use store::MetricStore;
pub use types::{Labels, MetricId, MetricKind, MetricSnapshot, RetentionPolicy, StoreConfig};
