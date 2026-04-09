use crate::error::MetricError;
use crate::store::MetricStore;
use crate::types::{
    CounterSnapshot, GaugeSnapshot, HistogramSnapshot, MetricKind, MetricSnapshot,
};

/// Collects snapshots of all metrics currently registered in `store`.
pub fn collect_snapshots(store: &MetricStore) -> Result<Vec<MetricSnapshot>, MetricError> {
    store.read_all_entries(|entries| {
        let mut snapshots = Vec::with_capacity(entries.len());
        for entry in entries.values() {
            let snap = match entry.kind {
                MetricKind::Counter => Some(MetricSnapshot::Counter(CounterSnapshot {
                    id: entry.id,
                    name: entry.name.clone(),
                    labels: entry.labels.clone(),
                    total: entry.total,
                    last_seen_ms: entry.last_seen_ms,
                })),
                MetricKind::Gauge => Some(MetricSnapshot::Gauge(GaugeSnapshot {
                    id: entry.id,
                    name: entry.name.clone(),
                    labels: entry.labels.clone(),
                    value: entry.gauge_value,
                    last_seen_ms: entry.last_seen_ms,
                })),
                MetricKind::Histogram => entry.histogram.as_ref().map(|hist| {
                    let summary = hist.snapshot();
                    MetricSnapshot::Histogram(HistogramSnapshot {
                        id: entry.id,
                        name: entry.name.clone(),
                        labels: entry.labels.clone(),
                        count: summary.count,
                        sum: summary.sum,
                        min: summary.min.unwrap_or(0.0),
                        max: summary.max.unwrap_or(0.0),
                        p50: summary.p50,
                        p90: summary.p90,
                        p99: summary.p99,
                        last_seen_ms: entry.last_seen_ms,
                    })
                }),
            };
            if let Some(s) = snap {
                snapshots.push(s);
            }
        }
        snapshots
    })
}

/// Renders all metrics in Prometheus text exposition format.
///
/// Counters produce a `# TYPE ... counter` header and a single value line.
/// Gauges produce a `# TYPE ... gauge` header and a single value line.
/// Histograms produce a `# TYPE ... summary` header with `_count`, `_sum`,
/// and quantile lines.
///
/// See: https://prometheus.io/docs/instrumenting/exposition_formats/
pub fn to_prometheus(store: &MetricStore) -> Result<String, MetricError> {
    let snapshots = collect_snapshots(store)?;
    let mut out = String::with_capacity(snapshots.len() * 64);

    for snap in &snapshots {
        let name = snap.name();
        let labels = snap.labels().to_prometheus_string();

        match snap {
            MetricSnapshot::Counter(c) => {
                out.push_str(&format!("# TYPE {} counter\n", name));
                out.push_str(&format!("{}{} {}\n", name, labels, c.total));
            }
            MetricSnapshot::Gauge(g) => {
                out.push_str(&format!("# TYPE {} gauge\n", name));
                out.push_str(&format!("{}{} {}\n", name, labels, format_f64(g.value)));
            }
            MetricSnapshot::Histogram(h) => {
                out.push_str(&format!("# TYPE {} summary\n", name));
                out.push_str(&format!("{}_count{} {}\n", name, labels, h.count));
                out.push_str(&format!("{}_sum{} {}\n", name, labels, format_f64(h.sum)));
                if let Some(p50) = h.p50 {
                    out.push_str(&format!(
                        "{}{}{{quantile=\"0.5\"}} {}\n",
                        name,
                        labels,
                        format_f64(p50)
                    ));
                }
                if let Some(p90) = h.p90 {
                    out.push_str(&format!(
                        "{}{}{{quantile=\"0.9\"}} {}\n",
                        name,
                        labels,
                        format_f64(p90)
                    ));
                }
                if let Some(p99) = h.p99 {
                    out.push_str(&format!(
                        "{}{}{{quantile=\"0.99\"}} {}\n",
                        name,
                        labels,
                        format_f64(p99)
                    ));
                }
            }
        }
    }

    Ok(out)
}

/// Serializes all metric snapshots to a JSON array string.
pub fn to_json(store: &MetricStore) -> Result<String, MetricError> {
    let snapshots = collect_snapshots(store)?;
    serde_json::to_string(&snapshots)
        .map_err(|e| MetricError::SerializationError(e.to_string()))
}

/// Formats an `f64` for Prometheus output: integer-valued floats are rendered
/// without a decimal point (e.g. `42` instead of `42`), and NaN/infinity are
/// rendered as their Prometheus text representations.
fn format_f64(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        if v > 0.0 {
            return "+Inf".to_string();
        } else {
            return "-Inf".to_string();
        }
    }
    // Use shortest decimal representation that round-trips.
    format!("{}", v)
}
