//! The Unix-socket bridge.
//!
//! A WebView cannot open a Unix socket, so this opens it and relays *frames* to
//! the WebView as raw bytes — never base64, never JSON-wrapped. Input and control
//! frames go back the other way.
//!
//! ## What this module knows
//!
//! Framing, and nothing else. It reads a length prefix and a kind byte so it can
//! apply the right back-pressure policy to each kind, and it never decodes a
//! payload. The constants below are mirrored from `packages/protocol/src/frame.ts`
//! by hand; they are *framing* constants and carry no protocol version, so the
//! handshake — and every version number in it — stays in `@janela/client`.
//! (docs/decisions/0024, ADR 0016.)
//!
//! ## Reconnection lives in `@janela/client`, not here
//!
//! `bridge_connect` makes exactly one attempt and never retries: #28 landed the
//! retry loop on the client, which counts the attempt, applies the backoff and
//! re-subscribes. Two retry loops in two languages is one too many. What survives
//! of ADR 0024's bridge rule is the other half: a connection that dies ends its
//! `bridge_receive` stream, which is how `incoming()` finishes and how the client
//! notices.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Instant;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{Mutex as AsyncMutex, Notify};

// ---------------------------------------------------------------- framing

/// Bytes of framing overhead ahead of every payload: four for the length, one for
/// the kind. Mirrors `FRAME_HEADER_LENGTH`.
const FRAME_HEADER_LENGTH: usize = 5;

/// Mirrors `MAXIMUM_PAYLOAD_LENGTH`. An unbounded length prefix read off a socket
/// is a memory-exhaustion bug waiting for a malformed first packet.
const MAXIMUM_PAYLOAD_LENGTH: usize = 8 * 1024 * 1024;

/// Mirrors `FrameKind.Control`. A JSON control message.
const KIND_CONTROL: u8 = 1;
/// Mirrors `FrameKind.Input`. Terminal input, client → daemon.
const KIND_INPUT: u8 = 2;
/// Mirrors `FrameKind.Output`. Repaint bytes, daemon → client.
const KIND_OUTPUT: u8 = 3;

/// Coalesced repaints a stalled WebView may owe before its oldest is dropped.
/// Mirrors `OUTPUT_QUEUE_CAPACITY` in `@janela/daemon`, deliberately: the daemon
/// applies the same bound to the same stream one hop upstream.
const BRIDGE_OUTPUT_QUEUE_CAPACITY: usize = 32;

/// Control messages a stalled WebView may owe before the connection is severed.
/// Mirrors `CONTROL_QUEUE_CAPACITY`.
const BRIDGE_CONTROL_QUEUE_CAPACITY: usize = 64;

/// Connections one WebView may hold. A reload leaks the previous one's id, and a
/// bridge that grew a socket per reload would be a descriptor leak with a very
/// slow fuse.
const BRIDGE_CONNECTION_CAPACITY: usize = 8;

/// Per-read request size. Large enough that a flood is a handful of syscalls.
const READ_SIZE: usize = 64 * 1024;

/// Header naming the connection a `bridge_send` belongs to.
///
/// A header rather than an argument because the body must stay a raw byte buffer:
/// the moment an id joins it, the frame is inside a JSON object and every repaint
/// pays for base64.
pub const CONNECTION_HEADER: &str = "x-janela-connection";

/// One whole encoded frame — header included — and its kind.
///
/// The bytes are kept exactly as they arrived. The relay's contract is that a
/// payload reaches the WebView byte-identical, and a frame that has been taken
/// apart and rebuilt is a frame that can differ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub bytes: Vec<u8>,
}

/// A frame we refuse to relay. Fatal to the connection and to nothing else.
#[derive(Debug, PartialEq, Eq)]
pub enum SplitError {
    /// The length prefix exceeded `MAXIMUM_PAYLOAD_LENGTH`.
    PayloadTooLarge(u32),
    /// A kind byte we do not know. Not forward-compatible on purpose: a peer that
    /// speaks a kind we do not know has failed the handshake's job.
    UnknownKind(u8),
}

/// Reassembles frames from arbitrary chunk boundaries.
///
/// Stateful because a socket delivers what it likes: a five-byte header can arrive
/// split across two reads, and a reader that assumes otherwise works until the day
/// it does not.
#[derive(Debug, Default)]
pub struct FrameSplitter {
    buffer: Vec<u8>,
}

impl FrameSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds bytes and returns whatever complete frames they completed.
    ///
    /// The header is validated the moment its fifth byte is available and *before*
    /// anything is reserved for the body: an over-long claim is an error, never an
    /// allocation.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, SplitError> {
        self.buffer.extend_from_slice(chunk);

        let mut frames = Vec::new();
        let mut offset = 0usize;
        while self.buffer.len() - offset >= FRAME_HEADER_LENGTH {
            let header = &self.buffer[offset..offset + FRAME_HEADER_LENGTH];
            let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
            if length as usize > MAXIMUM_PAYLOAD_LENGTH {
                return Err(SplitError::PayloadTooLarge(length));
            }
            let kind = header[4];
            if kind != KIND_CONTROL && kind != KIND_INPUT && kind != KIND_OUTPUT {
                return Err(SplitError::UnknownKind(kind));
            }

            let total = FRAME_HEADER_LENGTH + length as usize;
            if self.buffer.len() - offset < total {
                break;
            }
            frames.push(Frame {
                kind,
                bytes: self.buffer[offset..offset + total].to_vec(),
            });
            offset += total;
        }

        if offset > 0 {
            self.buffer.drain(..offset);
        }
        Ok(frames)
    }
}

// ---------------------------------------------------------------- back-pressure

/// What one connection owes the WebView, bounded, with a policy per kind.
///
/// ## The two policies, and why they differ
///
/// **Control frames and input are never dropped.** A dropped reply is a request
/// that never answers, and a dropped state update is a mirror that is silently
/// wrong. Overflow severs the connection instead, which is lossless: the client
/// reconnects and receives a full snapshot. That is the daemon's own stalled-peer
/// policy, one hop upstream.
///
/// **Output frames drop their oldest.** Repaints are coalesced, so the newest is
/// the one worth having.
///
/// ## What #32 must fix before it ships deltas
///
/// Drop-oldest is safe *today* only because every repaint frame is a full repaint
/// beginning `ESC c` (#21's `repaintSince` placeholder): losing one loses nothing
/// the next one does not carry. The moment repaints become deltas, a drop here is
/// a silent corruption the daemon's owed-full-repaint bookkeeping cannot see,
/// because the frame left the daemon successfully. #32 needs a recovery before
/// then — re-attach on drop, or sequence numbers the client can notice a gap in.
#[derive(Debug, Default)]
pub struct Queues {
    control: VecDeque<Frame>,
    output: VecDeque<Frame>,
    dropped: u64,
    severed: bool,
    ended: bool,
}

impl Queues {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, frame: Frame) {
        if frame.kind == KIND_OUTPUT {
            if self.output.len() >= BRIDGE_OUTPUT_QUEUE_CAPACITY {
                self.output.pop_front();
                self.dropped += 1;
            }
            self.output.push_back(frame);
            return;
        }
        if self.control.len() >= BRIDGE_CONTROL_QUEUE_CAPACITY {
            self.severed = true;
            return;
        }
        self.control.push_back(frame);
    }

    /// Everything owed, as one buffer: control frames first, then output.
    ///
    /// Order within a kind is preserved, which is the part that matters — repaints
    /// must arrive in sequence. Order *across* kinds is not preserved and never
    /// was: the daemon interleaves two queues of its own.
    pub fn drain(&mut self) -> Vec<u8> {
        let owed: usize = self
            .control
            .iter()
            .chain(self.output.iter())
            .map(|frame| frame.bytes.len())
            .sum();
        let mut bytes = Vec::with_capacity(owed);
        for frame in self.control.drain(..).chain(self.output.drain(..)) {
            bytes.extend_from_slice(&frame.bytes);
        }
        bytes
    }

    pub fn is_empty(&self) -> bool {
        self.control.is_empty() && self.output.is_empty()
    }

    /// Repaints dropped since this was last asked, and resets the count.
    ///
    /// Read on every poll and logged when it is non-zero: a drop is a shape worth
    /// a record — never a payload — and it is the only evidence #32 will have that
    /// a delta went missing here rather than in the daemon.
    pub fn take_dropped(&mut self) -> u64 {
        std::mem::replace(&mut self.dropped, 0)
    }

    pub fn is_severed(&self) -> bool {
        self.severed
    }
}

// ---------------------------------------------------------------- state

struct Connection {
    /// Behind an async mutex because `bridge_send` awaits the write: the invoke
    /// promise *is* the back-pressure on input, so there is no input queue to
    /// overflow and no keystroke to drop.
    writer: AsyncMutex<OwnedWriteHalf>,
    queues: SyncMutex<Queues>,
    notify: Notify,
}

#[derive(Default)]
pub struct BridgeState {
    connections: SyncMutex<HashMap<u32, Arc<Connection>>>,
    next_id: AtomicU32,
    /// Shared with `agent::kickstart`, which is throttled so a client retrying
    /// with backoff does not run `launchctl` once per attempt.
    pub last_kickstart: SyncMutex<Option<Instant>>,
}

/// `~/.janela/run/janelad.sock`. The same path `@janela/daemon`'s
/// `defaultSocketPath()` computes, and the only address either side knows.
fn socket_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut path = PathBuf::from(home);
    path.push(".janela");
    path.push("run");
    path.push("janelad.sock");
    Some(path)
}

/// A poisoned lock is recovered rather than propagated: the bridge holds the only
/// path to the user's terminals, and a panic here would take the window with it.
fn connections(state: &BridgeState) -> std::sync::MutexGuard<'_, HashMap<u32, Arc<Connection>>> {
    state
        .connections
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn queues(connection: &Connection) -> std::sync::MutexGuard<'_, Queues> {
    connection
        .queues
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lookup(state: &BridgeState, id: u32) -> Option<Arc<Connection>> {
    connections(state).get(&id).map(Arc::clone)
}

// ---------------------------------------------------------------- commands

/// Opens one connection to the daemon and returns its id.
///
/// **One attempt.** On failure it asks launchd to start the daemon — throttled,
/// because the client retries with backoff — and reports `daemon-unavailable`.
/// The retry itself is `@janela/client`'s (#28).
#[tauri::command]
pub async fn bridge_connect(state: State<'_, BridgeState>) -> Result<u32, String> {
    let path = socket_path().ok_or_else(|| "no-home-directory".to_string())?;

    let stream = match UnixStream::connect(&path).await {
        Ok(stream) => stream,
        Err(_) => {
            // No `RunAtLoad`, so nothing runs until a client asks: a user who
            // never opens Janela never has a process (ADR 0017, amended).
            crate::agent::kickstart(&state.last_kickstart);
            return Err("daemon-unavailable".to_string());
        }
    };

    let (mut reader, writer) = stream.into_split();
    let connection = Arc::new(Connection {
        writer: AsyncMutex::new(writer),
        queues: SyncMutex::new(Queues::new()),
        notify: Notify::new(),
    });

    // Never zero, so a falsy check on the JavaScript side cannot pass for an id.
    let id = state
        .next_id
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    {
        let mut map = connections(&state);
        while map.len() >= BRIDGE_CONNECTION_CAPACITY {
            // A reload leaves its connection behind with nobody polling it. The
            // oldest id is the one whose WebView is furthest gone.
            let oldest = map.keys().copied().min();
            match oldest {
                Some(key) => {
                    if let Some(stale) = map.remove(&key) {
                        queues(&stale).ended = true;
                        stale.notify.notify_waiters();
                    }
                }
                None => break,
            }
        }
        map.insert(id, Arc::clone(&connection));
    }

    let pump = Arc::clone(&connection);
    tauri::async_runtime::spawn(async move {
        let mut splitter = FrameSplitter::new();
        let mut buffer = vec![0u8; READ_SIZE];
        loop {
            let read = reader.read(&mut buffer).await;
            let count = match read {
                Ok(0) | Err(_) => {
                    // EOF or a dead socket. Ending the stream is how `incoming()`
                    // finishes, which is how the client notices and retries.
                    queues(&pump).ended = true;
                    pump.notify.notify_waiters();
                    return;
                }
                Ok(count) => count,
            };

            match splitter.push(&buffer[..count]) {
                Ok(frames) => {
                    let mut owed = queues(&pump);
                    for frame in frames {
                        owed.push(frame);
                    }
                    drop(owed);
                    pump.notify.notify_waiters();
                }
                Err(_) => {
                    // A frame we refuse to relay. Severing is lossless: the client
                    // reconnects and receives a full snapshot.
                    queues(&pump).severed = true;
                    pump.notify.notify_waiters();
                    return;
                }
            }
        }
    });

    Ok(id)
}

/// Long-polls for frames owed to the WebView.
///
/// Returns raw bytes — an `ArrayBuffer` in JavaScript, with no base64 and no JSON
/// wrapper. A zero-byte response means the connection ended cleanly; an error
/// means it did not.
#[tauri::command]
pub async fn bridge_receive(state: State<'_, BridgeState>, id: u32) -> Result<Response, String> {
    // A poll arriving after a close is routine — the WebView's generator is one
    // await behind — and an empty response ends it cleanly.
    let Some(connection) = lookup(&state, id) else {
        return Ok(Response::new(Vec::new()));
    };

    loop {
        // Registered *before* the queues are checked: a frame arriving in the
        // window between the check and the await would otherwise be a wakeup lost
        // until the next one, which for an idle terminal is forever.
        let notified = connection.notify.notified();
        {
            let mut owed = queues(&connection);
            if owed.is_severed() {
                drop(owed);
                connections(&state).remove(&id);
                return Err("bridge-stalled".to_string());
            }
            if !owed.is_empty() {
                let bytes = owed.drain();
                let dropped = owed.take_dropped();
                drop(owed);
                if dropped > 0 {
                    // A shape, not a payload. Safe today because every repaint is
                    // a full repaint; see `Queues`' note on what #32 owes.
                    log::warn!(target: "protocol", "bridge dropped {dropped} coalesced repaints");
                }
                return Ok(Response::new(bytes));
            }
            if owed.ended {
                drop(owed);
                connections(&state).remove(&id);
                return Ok(Response::new(Vec::new()));
            }
        }
        notified.await;
    }
}

/// Writes one already-encoded frame to the daemon.
///
/// The body must be raw bytes. Awaited to completion, which is what makes the
/// invoke promise the back-pressure on terminal input: there is no queue here to
/// overflow, and therefore no keystroke to drop.
#[tauri::command]
pub async fn bridge_send(
    state: State<'_, BridgeState>,
    request: Request<'_>,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get(CONNECTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "missing-connection-header".to_string())?;

    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected-raw-body".to_string());
    };

    let connection = lookup(&state, id).ok_or_else(|| "unknown-connection".to_string())?;
    let mut writer = connection.writer.lock().await;
    writer
        .write_all(bytes)
        .await
        .map_err(|_| "write-failed".to_string())?;
    writer.flush().await.map_err(|_| "flush-failed".to_string())
}

/// Closes one connection.
///
/// This is what unblocks a parked `bridge_receive`, which is what lets the
/// transport's `incoming()` finish when the client disconnects deliberately —
/// #28's hard requirement, and the difference between a clean disconnect and a
/// generator that never returns.
#[tauri::command]
pub async fn bridge_close(state: State<'_, BridgeState>, id: u32) -> Result<(), String> {
    let removed = connections(&state).remove(&id);
    if let Some(connection) = removed {
        queues(&connection).ended = true;
        connection.notify.notify_waiters();
        let mut writer = connection.writer.lock().await;
        let _ = writer.shutdown().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A whole frame: four length bytes, one kind byte, then the payload.
    fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.push(kind);
        bytes.extend_from_slice(payload);
        bytes
    }

    /// Bytes that are not valid UTF-8 in any encoding: a lone continuation byte,
    /// an unpaired surrogate lead, and a truncated two-byte sequence.
    const NOT_UTF8: [u8; 5] = [0xff, 0xfe, 0x80, 0xc3, 0x28];

    #[test]
    fn an_invalid_utf8_payload_survives_the_splitter_byte_identical() {
        let mut splitter = FrameSplitter::new();

        let frames = splitter
            .push(&encode(KIND_OUTPUT, &NOT_UTF8))
            .expect("split");

        assert_eq!(frames.len(), 1);
        assert_eq!(&frames[0].bytes[FRAME_HEADER_LENGTH..], &NOT_UTF8);
    }

    #[test]
    fn an_invalid_utf8_payload_survives_the_queues_byte_identical() {
        let mut queues = Queues::new();
        queues.push(Frame {
            kind: KIND_OUTPUT,
            bytes: encode(KIND_OUTPUT, &NOT_UTF8),
        });

        let drained = queues.drain();

        assert_eq!(&drained[FRAME_HEADER_LENGTH..], &NOT_UTF8);
    }

    #[test]
    fn a_frame_split_mid_header_and_mid_payload_reassembles() {
        let whole = encode(KIND_CONTROL, b"{\"type\":\"hello\"}");
        let mut splitter = FrameSplitter::new();

        // Three bytes of the five-byte header, then the rest of the header plus
        // part of the payload, then the remainder.
        assert!(splitter.push(&whole[..3]).expect("split").is_empty());
        assert!(splitter.push(&whole[3..9]).expect("split").is_empty());
        let frames = splitter.push(&whole[9..]).expect("split");

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes, whole);
    }

    #[test]
    fn two_frames_in_one_chunk_both_arrive_in_order() {
        let mut chunk = encode(KIND_CONTROL, b"first");
        chunk.extend_from_slice(&encode(KIND_OUTPUT, b"second"));
        let mut splitter = FrameSplitter::new();

        let frames = splitter.push(&chunk).expect("split");

        assert_eq!(frames.len(), 2);
        assert_eq!(&frames[0].bytes[FRAME_HEADER_LENGTH..], b"first");
        assert_eq!(&frames[1].bytes[FRAME_HEADER_LENGTH..], b"second");
    }

    #[test]
    fn an_oversize_length_prefix_is_refused_before_anything_is_reserved() {
        let mut header = ((MAXIMUM_PAYLOAD_LENGTH + 1) as u32).to_be_bytes().to_vec();
        header.push(KIND_OUTPUT);
        let mut splitter = FrameSplitter::new();

        let outcome = splitter.push(&header);

        assert_eq!(
            outcome,
            Err(SplitError::PayloadTooLarge(
                (MAXIMUM_PAYLOAD_LENGTH + 1) as u32
            ))
        );
    }

    #[test]
    fn an_unknown_kind_byte_is_refused() {
        let mut splitter = FrameSplitter::new();

        let outcome = splitter.push(&encode(9, b"whatever"));

        assert_eq!(outcome, Err(SplitError::UnknownKind(9)));
    }

    #[test]
    fn output_overflow_drops_its_oldest_and_counts_it() {
        let mut queues = Queues::new();
        for index in 0..BRIDGE_OUTPUT_QUEUE_CAPACITY + 1 {
            queues.push(Frame {
                kind: KIND_OUTPUT,
                bytes: encode(KIND_OUTPUT, &[index as u8]),
            });
        }

        assert_eq!(queues.take_dropped(), 1);
        assert!(!queues.is_severed());

        let drained = queues.drain();
        assert_eq!(drained.len(), BRIDGE_OUTPUT_QUEUE_CAPACITY * 6);
        // The oldest went, so the first payload byte is 1 rather than 0, and the
        // newest repaint — the one worth having — is still there.
        assert_eq!(drained[FRAME_HEADER_LENGTH], 1);
        assert_eq!(
            drained[drained.len() - 1],
            BRIDGE_OUTPUT_QUEUE_CAPACITY as u8
        );
    }

    #[test]
    fn control_overflow_severs_rather_than_dropping_a_reply() {
        let mut queues = Queues::new();
        for index in 0..BRIDGE_CONTROL_QUEUE_CAPACITY + 1 {
            queues.push(Frame {
                kind: KIND_CONTROL,
                bytes: encode(KIND_CONTROL, &[index as u8]),
            });
        }

        assert!(queues.is_severed());
        // Nothing was dropped: a dropped reply is a request that never answers,
        // and severing is lossless because the client reconnects into a snapshot.
        assert_eq!(queues.take_dropped(), 0);
        let drained = queues.drain();
        assert_eq!(drained[FRAME_HEADER_LENGTH], 0);
    }

    #[test]
    fn input_frames_take_the_control_policy_and_are_never_dropped() {
        let mut queues = Queues::new();
        for index in 0..BRIDGE_CONTROL_QUEUE_CAPACITY {
            queues.push(Frame {
                kind: KIND_INPUT,
                bytes: encode(KIND_INPUT, &[index as u8]),
            });
        }

        assert_eq!(queues.take_dropped(), 0);
        assert!(!queues.is_severed());
    }

    #[test]
    fn drain_preserves_order_within_a_kind_and_puts_control_first() {
        let mut queues = Queues::new();
        queues.push(Frame {
            kind: KIND_OUTPUT,
            bytes: encode(KIND_OUTPUT, b"o1"),
        });
        queues.push(Frame {
            kind: KIND_CONTROL,
            bytes: encode(KIND_CONTROL, b"c1"),
        });
        queues.push(Frame {
            kind: KIND_OUTPUT,
            bytes: encode(KIND_OUTPUT, b"o2"),
        });

        let drained = queues.drain();

        let mut expected = encode(KIND_CONTROL, b"c1");
        expected.extend_from_slice(&encode(KIND_OUTPUT, b"o1"));
        expected.extend_from_slice(&encode(KIND_OUTPUT, b"o2"));
        assert_eq!(drained, expected);
    }

    #[test]
    fn a_drained_queue_is_empty_again() {
        let mut queues = Queues::new();
        queues.push(Frame {
            kind: KIND_OUTPUT,
            bytes: encode(KIND_OUTPUT, b"x"),
        });

        queues.drain();

        assert!(queues.is_empty());
        assert!(queues.drain().is_empty());
    }
}
