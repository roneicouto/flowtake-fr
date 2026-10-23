use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Bounded, per-process diagnostics. It must not hold AppState's lock while
/// waiting for the stderr reader: that reader emits events through the app.
#[derive(Clone, Default)]
pub(crate) struct CaptureDiagnostics {
    inner: Arc<(Mutex<DiagnosticState>, Condvar)>,
    redactions: Arc<Vec<String>>,
}

#[derive(Default)]
struct DiagnosticState {
    lines: VecDeque<String>,
    complete: bool,
}

impl CaptureDiagnostics {
    pub(crate) fn new(mut redactions: Vec<String>) -> Self {
        redactions.retain(|value| !value.is_empty());
        redactions.sort_by_key(|value| std::cmp::Reverse(value.len()));
        Self {
            redactions: Arc::new(redactions),
            ..Self::default()
        }
    }

    pub(crate) fn record(&self, message: &str) {
        let message = message.trim();
        // Progress can otherwise evict the actual failure at shutdown.
        if message.is_empty() || message.starts_with("frame=") {
            return;
        }
        let mut sanitized = message.to_string();
        for value in self.redactions.iter() {
            sanitized = sanitized.replace(value, "<redacted>");
        }
        let sanitized: String = sanitized.chars().take(1024).collect();
        let mut state = self.inner.0.lock().unwrap();
        if state.lines.len() == 64 {
            state.lines.pop_front();
        }
        state.lines.push_back(sanitized);
    }

    pub(crate) fn finish(&self) {
        self.inner.0.lock().unwrap().complete = true;
        self.inner.1.notify_all();
    }

    pub(crate) fn summary(&self) -> String {
        let state = self.inner.0.lock().unwrap();
        let (state, _) = self
            .inner
            .1
            .wait_timeout_while(state, Duration::from_millis(500), |state| !state.complete)
            .unwrap();
        // Prefer operation-specific failures to the generic final statistics.
        let errors: Vec<_> = state
            .lines
            .iter()
            .filter(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("failed") || lower.contains("error")
            })
            .collect();
        let lines: Vec<_> = if errors.is_empty() {
            state.lines.iter().collect()
        } else {
            errors
        };
        lines
            .into_iter()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" | ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_survives_progress_and_redacts_owned_paths() {
        let diagnostics = CaptureDiagnostics::new(vec!["C:\\private\\screen.mp4".into()]);
        diagnostics.record("[h264_amf] SubmitInput() failed with error 18");
        for _ in 0..1000 {
            diagnostics.record("frame= 1 fps=30");
        }
        diagnostics.record("Error writing C:\\private\\screen.mp4");
        diagnostics.finish();
        let summary = diagnostics.summary();
        assert!(summary.contains("SubmitInput() failed with error 18"));
        assert!(summary.contains("<redacted>"));
        assert!(!summary.contains("private"));
    }

    #[test]
    fn reader_completion_drains_final_operation_before_summary() {
        let diagnostics = CaptureDiagnostics::default();
        let reader = diagnostics.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            reader.record("Drain() failed with error 18");
            reader.finish();
        });
        assert!(diagnostics.summary().contains("Drain() failed"));
        thread.join().unwrap();
    }

    #[test]
    fn storage_is_bounded_and_sessions_are_independent() {
        let diagnostics = CaptureDiagnostics::default();
        for _ in 0..1000 {
            diagnostics.record(&"x".repeat(2000));
        }
        let state = diagnostics.inner.0.lock().unwrap();
        assert_eq!(state.lines.len(), 64);
        assert!(state.lines.iter().all(|line| line.len() == 1024));
        drop(state);
        let next = CaptureDiagnostics::default();
        next.finish();
        assert!(next.summary().is_empty());
    }
}
