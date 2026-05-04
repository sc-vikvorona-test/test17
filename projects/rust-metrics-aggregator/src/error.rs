use std::fmt;

/// Errors produced by the metrics aggregator library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetricError {
    /// A metric with this name already exists with a different kind.
    KindMismatch {
        name: String,
        expected: &'static str,
        got: &'static str,
    },
    /// The requested metric was not found.
    NotFound(String),
    /// An invalid configuration was supplied (e.g. zero buckets).
    InvalidConfig(String),
    /// A percentile value was out of the [0.0, 1.0] range.
    InvalidPercentile(f64),
    /// The underlying RwLock was poisoned.
    LockPoisoned,
    /// Serialization to the export format failed.
    SerializationError(String),
}

impl fmt::Display for MetricError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MetricError::KindMismatch { name, expected, got } => write!(
                f,
                "metric '{}' already registered as {} but requested as {}",
                name, expected, got
            ),
            MetricError::NotFound(name) => write!(f, "metric '{}' not found", name),
            MetricError::InvalidConfig(msg) => write!(f, "invalid configuration: {}", msg),
            MetricError::InvalidPercentile(p) => {
                write!(f, "percentile {} is outside [0.0, 1.0]", p)
            }
            MetricError::LockPoisoned => write!(f, "internal lock was poisoned"),
            MetricError::SerializationError(msg) => {
                write!(f, "serialization failed: {}", msg)
            }
        }
    }
}

impl std::error::Error for MetricError {}

impl<T> From<std::sync::PoisonError<T>> for MetricError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        MetricError::LockPoisoned
    }
}
