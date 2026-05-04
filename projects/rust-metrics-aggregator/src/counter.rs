use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// A lock-free atomic counter supporting concurrent increments and periodic snapshots.
///
/// Internally uses a single `AtomicU64` for the live value and another for the
/// all-time total, which is never reset.
#[derive(Debug)]
pub struct AtomicCounter {
    /// Running total that is reset on each snapshot cycle.
    value: AtomicU64,
    /// Cumulative total that is never reset.
    cumulative: AtomicU64,
}

impl AtomicCounter {
    /// Creates a new counter starting at zero.
    pub fn new() -> Self {
        AtomicCounter {
            value: AtomicU64::new(0),
            cumulative: AtomicU64::new(0),
        }
    }

    /// Increments the counter by `delta`. Panics if `delta` would overflow `u64`.
    pub fn increment(&self, delta: u64) {
        self.value.fetch_add(delta, Ordering::Relaxed);
        self.cumulative.fetch_add(delta, Ordering::Relaxed);
    }

    /// Returns the current live value without resetting it.
    pub fn get(&self) -> u64 {
        self.value.load(Ordering::Acquire)
    }

    /// Returns the cumulative all-time total.
    pub fn cumulative(&self) -> u64 {
        self.cumulative.load(Ordering::Acquire)
    }

    /// Atomically reads the current value and resets the live counter to zero.
    ///
    /// Returns the value that was captured before the reset.
    /// If the value changed between read and compare-exchange, retries until
    /// the exchange succeeds.
    pub fn snapshot_and_reset(&self) -> u64 {
        loop {
            let current = self.value.load(Ordering::Acquire);
            match self.value.compare_exchange(
                current,
                0,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(v) => return v,
                Err(_) => continue,
            }
        }
    }
}

impl Default for AtomicCounter {
    fn default() -> Self {
        Self::new()
    }
}

/// A shared, reference-counted atomic counter for use across threads.
#[derive(Debug, Clone)]
pub struct SharedCounter(Arc<AtomicCounter>);

impl SharedCounter {
    pub fn new() -> Self {
        SharedCounter(Arc::new(AtomicCounter::new()))
    }

    pub fn increment(&self, delta: u64) {
        self.0.increment(delta);
    }

    pub fn get(&self) -> u64 {
        self.0.get()
    }

    pub fn cumulative(&self) -> u64 {
        self.0.cumulative()
    }

    pub fn snapshot_and_reset(&self) -> u64 {
        self.0.snapshot_and_reset()
    }
}

impl Default for SharedCounter {
    fn default() -> Self {
        Self::new()
    }
}
