use crate::error::MetricError;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Configuration for a histogram metric.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistogramConfig {
    /// Maximum number of raw samples to retain before compaction.
    pub max_samples: usize,
}

impl Default for HistogramConfig {
    fn default() -> Self {
        HistogramConfig { max_samples: 10_000 }
    }
}

/// A thread-safe histogram that records a distribution of `f64` values.
///
/// Internally retains up to `max_samples` raw observations. When the sample
/// buffer is full, older samples are evicted using reservoir-style replacement
/// so that percentile estimates remain accurate over time.
#[derive(Debug)]
pub struct Histogram {
    inner: Arc<Mutex<HistogramInner>>,
    config: HistogramConfig,
}

#[derive(Debug)]
struct HistogramInner {
    samples: Vec<f64>,
    count: u64,
    sum: f64,
    min: f64,
    max: f64,
    /// Reservoir index used for replacement once samples is full.
    reservoir_idx: usize,
}

impl HistogramInner {
    fn new() -> Self {
        HistogramInner {
            samples: Vec::new(),
            count: 0,
            sum: 0.0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            reservoir_idx: 0,
        }
    }

    fn observe(&mut self, value: f64, max_samples: usize) {
        self.count += 1;
        self.sum += value;
        if value < self.min {
            self.min = value;
        }
        if value > self.max {
            self.max = value;
        }

        if self.samples.len() < max_samples {
            self.samples.push(value);
        } else {
            // Overwrite the oldest sample in a round-robin fashion.
            let idx = self.reservoir_idx % max_samples;
            self.samples[idx] = value;
            self.reservoir_idx = self.reservoir_idx.wrapping_add(1);
        }
    }
}

impl Histogram {
    /// Creates a new histogram with the given configuration.
    pub fn new(config: HistogramConfig) -> Self {
        Histogram {
            inner: Arc::new(Mutex::new(HistogramInner::new())),
            config,
        }
    }

    /// Records a single observation.
    pub fn observe(&self, value: f64) {
        let mut guard = self.inner.lock().expect("histogram lock poisoned");
        guard.observe(value, self.config.max_samples);
    }

    /// Returns the total number of observations recorded.
    pub fn count(&self) -> u64 {
        self.inner.lock().expect("histogram lock poisoned").count
    }

    /// Returns the sum of all observations.
    pub fn sum(&self) -> f64 {
        self.inner.lock().expect("histogram lock poisoned").sum
    }

    /// Returns the minimum observed value, or `None` if no observations have been made.
    pub fn min(&self) -> Option<f64> {
        let g = self.inner.lock().expect("histogram lock poisoned");
        if g.count == 0 {
            None
        } else {
            Some(g.min)
        }
    }

    /// Returns the maximum observed value, or `None` if no observations have been made.
    pub fn max(&self) -> Option<f64> {
        let g = self.inner.lock().expect("histogram lock poisoned");
        if g.count == 0 {
            None
        } else {
            Some(g.max)
        }
    }

    /// Returns the mean of all observations, or `None` if no observations have been made.
    pub fn mean(&self) -> Option<f64> {
        let g = self.inner.lock().expect("histogram lock poisoned");
        if g.count == 0 {
            None
        } else {
            Some(g.sum / g.count as f64)
        }
    }

    /// Returns the estimated value at the given percentile `p` (where `p ∈ [0.0, 1.0]`).
    ///
    /// Uses a sorted copy of the current sample buffer for the estimate.
    /// Returns `None` if no observations have been made.
    /// Returns an error if `p` is outside `[0.0, 1.0]`.
    pub fn percentile(&self, p: f64) -> Result<Option<f64>, MetricError> {
        if !(0.0..=1.0).contains(&p) {
            return Err(MetricError::InvalidPercentile(p));
        }
        let guard = self.inner.lock().expect("histogram lock poisoned");
        if guard.samples.is_empty() {
            return Ok(None);
        }
        let mut sorted = guard.samples.clone();
        drop(guard);
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx = (sorted.len() as f64 * p) as usize;
        Ok(Some(sorted[idx]))
    }

    /// Resets the histogram, clearing all observations.
    pub fn reset(&self) {
        let mut guard = self.inner.lock().expect("histogram lock poisoned");
        *guard = HistogramInner::new();
    }

    /// Returns a point-in-time snapshot of this histogram's summary statistics.
    pub fn snapshot(&self) -> HistogramSummary {
        let guard = self.inner.lock().expect("histogram lock poisoned");
        let count = guard.count;
        let sum = guard.sum;
        let min = if count > 0 { Some(guard.min) } else { None };
        let max = if count > 0 { Some(guard.max) } else { None };
        let mut sorted = guard.samples.clone();
        drop(guard);

        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let percentile_of = |p: f64| -> Option<f64> {
            if sorted.is_empty() {
                return None;
            }
            let idx = (sorted.len() as f64 * p) as usize;
            Some(sorted[idx])
        };

        HistogramSummary {
            count,
            sum,
            min,
            max,
            p50: percentile_of(0.50),
            p90: percentile_of(0.90),
            p99: percentile_of(0.99),
        }
    }
}

impl Clone for Histogram {
    fn clone(&self) -> Self {
        Histogram {
            inner: Arc::clone(&self.inner),
            config: self.config.clone(),
        }
    }
}

/// A point-in-time summary of a histogram's distribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistogramSummary {
    pub count: u64,
    pub sum: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub p50: Option<f64>,
    pub p90: Option<f64>,
    pub p99: Option<f64>,
}
