//! One bounded writer per connection. Roster locks never cover network I/O.
use iroh::endpoint::{Connection, SendStream};
use std::{collections::VecDeque, sync::{Arc, Mutex}, time::Duration};
use tokio::sync::Notify;

const MAX_ITEMS: usize = 512;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Queue {
    items: VecDeque<(Option<String>, Arc<str>)>,
    bytes: usize,
    closed: bool,
}

impl Queue {
    fn push(&mut self, key: Option<String>, line: Arc<str>) -> Result<(), &'static str> {
        if self.closed { return Err("Connection writer is closed"); }
        if let Some(ref key) = key {
            if let Some((_, old)) = self.items.iter_mut().find(|(k, _)| k.as_ref() == Some(key)) {
                let bytes = self.bytes - old.len() + line.len();
                if bytes > MAX_BYTES { return Err("Connection queue is full"); }
                self.bytes = bytes;
                *old = line;
                return Ok(());
            }
        }
        if self.items.len() >= MAX_ITEMS || self.bytes + line.len() > MAX_BYTES {
            return Err("Connection queue is full");
        }
        self.bytes += line.len();
        self.items.push_back((key, line));
        Ok(())
    }
    fn pop(&mut self) -> Option<Arc<str>> {
        let (_, line) = self.items.pop_front()?;
        self.bytes -= line.len();
        Some(line)
    }
}

#[derive(Clone)]
pub(super) struct ControlSender {
    queue: Arc<Mutex<Queue>>,
    notify: Arc<Notify>,
    conn: Connection,
}

impl ControlSender {
    pub(super) fn enqueue(&self, line: Arc<str>, key: Option<String>) -> Result<(), crate::AppError> {
        let result = self.queue.lock().unwrap_or_else(|e| e.into_inner()).push(key, line);
        if let Err(message) = result {
            // Do not silently discard durable data. Close this connection;
            // its read loop removes this exact connection generation and the
            // remote's durable outbox can retry after reconnecting.
            self.conn.close(1u32.into(), message.as_bytes());
            return Err(crate::AppError::Network(message.into()));
        }
        self.notify.notify_one();
        Ok(())
    }
}

pub(super) fn spawn_writer(conn: Connection, mut send: SendStream) -> ControlSender {
    // Reliable commands/notes outrank file-transfer streams on this QUIC connection.
    let _ = send.set_priority(100);
    let sender = ControlSender { queue: Arc::new(Mutex::new(Queue::default())), notify: Arc::new(Notify::new()), conn: conn.clone() };
    let queue = sender.queue.clone();
    let notify = sender.notify.clone();
    tokio::spawn(async move {
        loop {
            let notified = notify.notified();
            let line = queue.lock().unwrap_or_else(|e| e.into_inner()).pop();
            if let Some(line) = line {
                let result = tokio::select! {
                    _ = conn.closed() => break,
                    result = tokio::time::timeout(Duration::from_secs(5), send.write_all(line.as_bytes())) => result,
                };
                if !matches!(result, Ok(Ok(()))) {
                    conn.close(1u32.into(), b"control writer stalled");
                    break;
                }
            } else {
                tokio::select! { _ = conn.closed() => break, _ = notified => {} }
            }
        }
        let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
        q.closed = true;
        q.items.clear();
        q.bytes = 0;
    });
    sender
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeats_coalesce_but_distinct_commands_and_edits_keep_order() {
        let mut q = Queue::default();
        q.push(Some("command:1".into()), "beat1".into()).unwrap();
        q.push(None, "edit".into()).unwrap();
        q.push(Some("command:2".into()), "next".into()).unwrap();
        q.push(Some("command:1".into()), "beat2".into()).unwrap();
        assert_eq!(&*q.pop().unwrap(), "beat2");
        assert_eq!(&*q.pop().unwrap(), "edit");
        assert_eq!(&*q.pop().unwrap(), "next");
        assert_eq!(q.bytes, 0);
    }
    #[test]
    fn one_full_queue_does_not_block_another_or_evict_an_edit() {
        let mut slow = Queue::default();
        let mut fast = Queue::default();
        for _ in 0..MAX_ITEMS { slow.push(None, "edit".into()).unwrap(); }
        assert!(slow.push(None, "new".into()).is_err());
        fast.push(None, "new".into()).unwrap();
        assert_eq!(&*fast.pop().unwrap(), "new");
        assert_eq!(slow.items.len(), MAX_ITEMS);
    }
}
