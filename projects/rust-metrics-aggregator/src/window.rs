use crate::error::MetricError;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// A single time bucket holding aggregated metric events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bucket {
    /// The start time (inclusive) of this bucket, in milliseconds since epoch.
    pub start_ms: u64,
    /// Accumulated sum of values recorded in this bucket.
    pub sum: f64,
    /// Number of events recorded in this bucket.
    pub count: u64,
    /// Minimum value seen in this bucket.
    pub min: f64,
    /// Maximum value seen in this bucket.
    pub max: f64,
}

impl Bucket {
    fn new(start_ms: u64) -> Self {
        Bucket {
            start_ms,
            sum: 0.0,
            count: 0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
        }
    }

    fn record(&mut self, value: f64) {
        self.sum += value;
        self.count += 1;
        if value < self.min {
            self.min = value;
        }
        if value > self.max {
            self.max = value;
        }
    }

    fn is_empty(&self) -> bool {
        self.count == 0
    }
}

/// A sliding window of fixed-size time buckets for temporal aggregation.
///
/// The window maintains a circular buffer of `num_buckets` buckets, each
/// covering `bucket_duration_ms` milliseconds. Old buckets are evicted
/// automatically as time advances.
#[derive(Debug)]
pub struct SlidingWindow {
    /// Circular buffer of buckets indexed by time.
    buckets: Vec<Option<Bucket>>,
    num_buckets: usize,
    bucket_duration_ms: u64,
    /// Monotonic high-water mark: the bucket index of the most recent write.
    latest_bucket: Option<u64>,
}

impl SlidingWindow {
    /// Creates a new sliding window.
    ///
    /// # Errors
    /// Returns `InvalidConfig` if `num_buckets` or `bucket_duration_ms` is zero.
    pub fn new(num_buckets: usize, bucket_duration_ms: u64) -> Result<Self, MetricError> {
        if num_buckets == 0 {
            return Err(MetricError::InvalidConfig(
                "num_buckets must be greater than zero".into(),
            ));
        }
        if bucket_duration_ms == 0 {
            return Err(MetricError::InvalidConfig(
                "bucket_duration_ms must be greater than zero".into(),
            ));
        }
        Ok(SlidingWindow {
            buckets: vec![None; num_buckets],
            num_buckets,
            bucket_duration_ms,
            latest_bucket: None,
        })
    }

    /// Computes the slot index in the circular buffer for a given timestamp.
    fn bucket_index(&self, timestamp_ms: u64) -> usize {
        ((timestamp_ms / self.bucket_duration_ms) % (self.num_buckets as u64 + 1)) as usize
    }

    /// Computes the absolute bucket sequence number for a given timestamp.
    fn bucket_seq(&self, timestamp_ms: u64) -> u64 {
        timestamp_ms / self.bucket_duration_ms
    }

    /// Records a value at the given timestamp.
    ///
    /// Evicts any bucket that is older than the window duration relative to
    /// the current timestamp.
    pub fn record(&mut self, timestamp_ms: u64, value: f64) {
        let seq = self.bucket_seq(timestamp_ms);
        let slot = self.bucket_index(timestamp_ms);
        let bucket_start = seq * self.bucket_duration_ms;

        if let Some(latest_seq) = self.latest_bucket {
            // Evict stale buckets if time has advanced significantly.
            if seq > latest_seq {
                let stale_count = (seq - latest_seq).min(self.num_buckets as u64);
                for i in 1..=stale_count {
                    let evict_seq = latest_seq + i;
                    let evict_slot = (evict_seq % self.num_buckets as u64) as usize;
                    self.buckets[evict_slot] = None;
                }
                self.latest_bucket = Some(seq);
            }
        } else {
            self.latest_bucket = Some(seq);
        }

        match &mut self.buckets[slot] {
            Some(b) if b.start_ms == bucket_start => {
                b.record(value);
            }
            slot_ref => {
                let mut new_bucket = Bucket::new(bucket_start);
                new_bucket.record(value);
                *slot_ref = Some(new_bucket);
            }
        }
    }

    /// Returns all non-empty, non-expired buckets within the window, sorted by start time.
    pub fn active_buckets(&self, now_ms: u64) -> Vec<&Bucket> {
        let window_start_ms = now_ms.saturating_sub(self.num_buckets as u64 * self.bucket_duration_ms);
        let mut result: Vec<&Bucket> = self
            .buckets
            .iter()
            .filter_map(|b| b.as_ref())
            .filter(|b| b.start_ms >= window_start_ms && !b.is_empty())
            .collect();
        result.sort_by_key(|b| b.start_ms);
        result
    }

    /// Aggregates all active buckets into a single summary.
    pub fn aggregate(&self, now_ms: u64) -> WindowAggregate {
        let buckets = self.active_buckets(now_ms);
        let mut agg = WindowAggregate::default();
        for b in buckets {
            agg.total_count += b.count;
            agg.total_sum += b.sum;
            if b.min < agg.min {
                agg.min = b.min;
            }
            if b.max > agg.max {
                agg.max = b.max;
            }
        }
        agg
    }

    /// Clears all buckets.
    pub fn reset(&mut self) {
        for slot in &mut self.buckets {
            *slot = None;
        }
        self.latest_bucket = None;
    }

    pub fn num_buckets(&self) -> usize {
        self.num_buckets
    }

    pub fn bucket_duration_ms(&self) -> u64 {
        self.bucket_duration_ms
    }
}

/// Aggregated statistics over a sliding window.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WindowAggregate {
    pub total_count: u64,
    pub total_sum: f64,
    pub min: f64,
    pub max: f64,
}

impl WindowAggregate {
    pub fn mean(&self) -> Option<f64> {
        if self.total_count == 0 {
            None
        } else {
            Some(self.total_sum / self.total_count as f64)
        }
    }
}

/// A queue-backed sliding window for raw event timestamps.
///
/// Useful when individual event retention is required (rather than pre-bucketed).
#[derive(Debug)]
pub struct EventWindow {
    events: VecDeque<(u64, f64)>,
    window_duration_ms: u64,
}

impl EventWindow {
    pub fn new(window_duration_ms: u64) -> Self {
        EventWindow {
            events: VecDeque::new(),
            window_duration_ms,
        }
    }

    /// Inserts an event and evicts all events older than `window_duration_ms`.
    pub fn push(&mut self, timestamp_ms: u64, value: f64) {
        self.events.push_back((timestamp_ms, value));
        let cutoff = timestamp_ms.saturating_sub(self.window_duration_ms);
        while let Some(&(ts, _)) = self.events.front() {
            if ts < cutoff {
                self.events.pop_front();
            } else {
                break;
            }
        }
    }

    /// Returns an iterator over all events currently in the window.
    pub fn iter(&self) -> impl Iterator<Item = (u64, f64)> + '_ {
        self.events.iter().copied()
    }

    /// Number of events in the window.
    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}
