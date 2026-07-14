//! Parallel HTTP range download presented as a sequential `Read`.
//!
//! GitHub release assets are served with highly variable per-connection
//! throughput, so a single-stream download of the ~1.4 GiB proof-assets
//! archive can take several minutes. This module fetches fixed-size ranges on
//! a small worker pool and reassembles them in order, exposing the result as a
//! `Read` so the existing streaming extract/digest pipeline is unchanged.
//! Memory is bounded by the reassembly window (claimed-but-unconsumed chunks).

use std::collections::HashMap;
use std::io::{self, Read};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

/// 32 MiB ranges: large enough to amortize request overhead, small enough
/// that the buffered window stays modest.
pub const DEFAULT_CHUNK_SIZE: u64 = 32 * 1024 * 1024;
/// Concurrent range requests. GitHub's CDN sustains this comfortably.
pub const DEFAULT_WORKERS: usize = 6;
/// Maximum chunks claimed but not yet consumed (bounds memory to
/// `MAX_BUFFERED_CHUNKS * chunk_size`, 256 MiB at the defaults).
const MAX_BUFFERED_CHUNKS: u64 = 8;
const FETCH_ATTEMPTS: u32 = 3;
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// A source that can serve absolute byte ranges of a fixed-size object.
pub trait RangeSource: Send + Sync + 'static {
    fn fetch(&self, offset: u64, len: u64) -> Result<Vec<u8>, String>;
}

pub struct HttpRangeSource {
    pub client: reqwest::blocking::Client,
    pub url: String,
}

impl RangeSource for HttpRangeSource {
    fn fetch(&self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let end = offset + len - 1;
        let response = self
            .client
            .get(&self.url)
            .header(reqwest::header::RANGE, format!("bytes={offset}-{end}"))
            .send()
            .map_err(|err| format!("range request {offset}-{end}: {err}"))?;
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!(
                "server stopped honoring range requests (status {})",
                response.status()
            ));
        }
        let mut data = Vec::with_capacity(len as usize);
        response
            .take(len)
            .read_to_end(&mut data)
            .map_err(|err| format!("read range {offset}-{end}: {err}"))?;
        Ok(data)
    }
}

struct DownloadState {
    next_fetch: u64,
    next_emit: u64,
    chunks: HashMap<u64, Vec<u8>>,
    error: Option<String>,
    stop: bool,
    workers_alive: usize,
}

struct Shared {
    state: Mutex<DownloadState>,
    cond: Condvar,
}

/// Sequential `Read` over an object downloaded as parallel ranges.
pub struct ParallelRangeReader {
    shared: Arc<Shared>,
    total_chunks: u64,
    current: Vec<u8>,
    current_pos: usize,
}

impl ParallelRangeReader {
    pub fn new<S: RangeSource>(
        source: Arc<S>,
        total_size: u64,
        chunk_size: u64,
        workers: usize,
    ) -> Self {
        assert!(chunk_size > 0, "chunk size must be positive");
        let total_chunks = total_size.div_ceil(chunk_size);
        let workers = workers.max(1);
        let shared = Arc::new(Shared {
            state: Mutex::new(DownloadState {
                next_fetch: 0,
                next_emit: 0,
                chunks: HashMap::new(),
                error: None,
                stop: false,
                workers_alive: workers,
            }),
            cond: Condvar::new(),
        });
        for _ in 0..workers {
            let shared = Arc::clone(&shared);
            let source = Arc::clone(&source);
            thread::spawn(move || {
                worker_loop(
                    &shared,
                    source.as_ref(),
                    total_size,
                    chunk_size,
                    total_chunks,
                );
                let mut state = shared.state.lock().unwrap();
                state.workers_alive -= 1;
                shared.cond.notify_all();
            });
        }
        Self {
            shared,
            total_chunks,
            current: Vec::new(),
            current_pos: 0,
        }
    }
}

fn worker_loop(
    shared: &Shared,
    source: &dyn RangeSource,
    total_size: u64,
    chunk_size: u64,
    total_chunks: u64,
) {
    loop {
        let index = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.stop || state.error.is_some() || state.next_fetch >= total_chunks {
                    return;
                }
                if state.next_fetch - state.next_emit < MAX_BUFFERED_CHUNKS {
                    break;
                }
                state = shared.cond.wait(state).unwrap();
            }
            let index = state.next_fetch;
            state.next_fetch += 1;
            index
        };

        let offset = index * chunk_size;
        let len = chunk_size.min(total_size - offset);
        let mut outcome = Err("range download did not run".to_string());
        for attempt in 0..FETCH_ATTEMPTS {
            if shared.state.lock().unwrap().stop {
                return;
            }
            outcome = source.fetch(offset, len).and_then(|data| {
                if data.len() as u64 == len {
                    Ok(data)
                } else {
                    Err(format!(
                        "range at {offset} returned {} bytes, want {len}",
                        data.len()
                    ))
                }
            });
            if outcome.is_ok() {
                break;
            }
            if attempt + 1 < FETCH_ATTEMPTS {
                thread::sleep(RETRY_BASE_DELAY * (attempt + 1));
            }
        }

        let mut state = shared.state.lock().unwrap();
        match outcome {
            Ok(data) => {
                state.chunks.insert(index, data);
            }
            Err(err) => {
                state.error.get_or_insert(err);
            }
        }
        shared.cond.notify_all();
    }
}

impl Read for ParallelRangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.current_pos >= self.current.len() {
            let mut state = self.shared.state.lock().unwrap();
            loop {
                if let Some(err) = &state.error {
                    return Err(io::Error::other(err.clone()));
                }
                if state.next_emit >= self.total_chunks {
                    return Ok(0);
                }
                let next_emit = state.next_emit;
                if let Some(chunk) = state.chunks.remove(&next_emit) {
                    state.next_emit += 1;
                    self.shared.cond.notify_all();
                    self.current = chunk;
                    self.current_pos = 0;
                    break;
                }
                if state.workers_alive == 0 {
                    return Err(io::Error::other(
                        "range download workers exited unexpectedly",
                    ));
                }
                state = self.shared.cond.wait(state).unwrap();
            }
        }
        let n = (self.current.len() - self.current_pos).min(buf.len());
        buf[..n].copy_from_slice(&self.current[self.current_pos..self.current_pos + n]);
        self.current_pos += n;
        Ok(n)
    }
}

impl Drop for ParallelRangeReader {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        state.stop = true;
        self.shared.cond.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct MemorySource {
        data: Vec<u8>,
        fail_at_offset: Option<u64>,
        failures_left: AtomicU32,
    }

    impl MemorySource {
        fn new(data: Vec<u8>) -> Self {
            Self {
                data,
                fail_at_offset: None,
                failures_left: AtomicU32::new(0),
            }
        }
    }

    impl RangeSource for MemorySource {
        fn fetch(&self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
            if Some(offset) == self.fail_at_offset
                && self
                    .failures_left
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                        left.checked_sub(1)
                    })
                    .is_ok()
            {
                return Err("injected fetch failure".to_string());
            }
            let start = offset as usize;
            let end = (offset + len) as usize;
            if end > self.data.len() {
                return Err(format!("range {offset}+{len} beyond object"));
            }
            Ok(self.data[start..end].to_vec())
        }
    }

    fn patterned(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn reassembles_exactly_across_uneven_chunks() {
        let data = patterned(1_000_003);
        let source = Arc::new(MemorySource::new(data.clone()));
        let mut reader = ParallelRangeReader::new(source, data.len() as u64, 4096, 4);
        let mut out = Vec::new();
        reader.read_to_end(&mut out).expect("read all");
        assert_eq!(out, data);
    }

    #[test]
    fn handles_single_chunk_objects() {
        let data = patterned(100);
        let source = Arc::new(MemorySource::new(data.clone()));
        let mut reader = ParallelRangeReader::new(source, data.len() as u64, 4096, 4);
        let mut out = Vec::new();
        reader.read_to_end(&mut out).expect("read all");
        assert_eq!(out, data);
    }

    #[test]
    fn recovers_from_transient_fetch_failures() {
        let data = patterned(300_000);
        let mut source = MemorySource::new(data.clone());
        source.fail_at_offset = Some(8192);
        source.failures_left = AtomicU32::new(2); // fewer than FETCH_ATTEMPTS
        let mut reader = ParallelRangeReader::new(Arc::new(source), data.len() as u64, 8192, 3);
        let mut out = Vec::new();
        reader
            .read_to_end(&mut out)
            .expect("read all despite retries");
        assert_eq!(out, data);
    }

    #[test]
    fn surfaces_persistent_fetch_failures() {
        let data = patterned(300_000);
        let mut source = MemorySource::new(data.clone());
        source.fail_at_offset = Some(8192);
        source.failures_left = AtomicU32::new(u32::MAX);
        let mut reader = ParallelRangeReader::new(Arc::new(source), data.len() as u64, 8192, 3);
        let mut out = Vec::new();
        let err = reader.read_to_end(&mut out).unwrap_err();
        assert!(err.to_string().contains("injected fetch failure"));
    }

    #[test]
    fn drop_mid_download_stops_workers() {
        let data = patterned(2_000_000);
        let source = Arc::new(MemorySource::new(data.clone()));
        let mut reader = ParallelRangeReader::new(Arc::clone(&source), data.len() as u64, 4096, 4);
        let mut first = [0_u8; 1024];
        reader.read_exact(&mut first).expect("read first bytes");
        assert_eq!(&first[..], &data[..1024]);
        drop(reader); // must not hang or panic
    }
}
