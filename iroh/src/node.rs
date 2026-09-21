//! Iroh p2p mesh node for Maypop multiplayer.
//!
//! One `MpNode` per app session. Peers dial each other by `EndpointAddr`
//! (exchanged through the Maypop backend, which acts purely as rendezvous).
//! Every live connection joins an in-memory registry; each message is one
//! uni-directional QUIC stream (no framing needed), fanned out to JS as a
//! single event stream.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use n0_future::task;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// ALPN for the Maypop multiplayer mesh protocol.
pub const ALPN: &[u8] = b"maypop/multiplayer/0";

/// Refuse messages larger than this (one message = one uni stream).
const MAX_MESSAGE_SIZE: usize = 1024 * 1024;

/// Events surfaced to the embedding JS as a single stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// A peer connection is live (either side may have dialed).
    PeerConnected { peer: EndpointId },
    /// A full message arrived from a peer.
    Message { from: EndpointId, payload: String },
    /// The connection to a peer closed or failed.
    PeerDisconnected {
        peer: EndpointId,
        error: Option<String>,
    },
}

type ConnMap = Arc<Mutex<HashMap<EndpointId, Connection>>>;

#[derive(Debug, Clone)]
pub struct MpNode {
    router: Router,
    conns: ConnMap,
    events: broadcast::Sender<Event>,
}

impl MpNode {
    pub async fn spawn() -> Result<Self> {
        // Default transport config already keep-alives connections (iroh's
        // QuicTransportConfig sets keep_alive_interval), so quiet sessions
        // don't idle out. Connections can still drop (relay hiccups); the
        // SDK's discovery loop redials.
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await?;
        // Sized generously: BroadcastStream drops (lags) events when the JS
        // consumer stalls past the buffer — acceptable for a best-effort
        // transport, but make it take a real stall, not a burst.
        let (events, _) = broadcast::channel(1024);
        let conns: ConnMap = Arc::default();
        let handler = MpProtocol {
            conns: conns.clone(),
            events: events.clone(),
        };
        let router = Router::builder(endpoint).accept(ALPN, handler).spawn();
        Ok(Self {
            router,
            conns,
            events,
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Wait until the endpoint has a home relay, then return our dialable
    /// address (endpoint id + relay URL) for publishing to the rendezvous.
    pub async fn dialable_addr(&self) -> Result<EndpointAddr> {
        let endpoint = self.endpoint().clone();
        endpoint.online().await;
        Ok(endpoint.addr())
    }

    /// Dial a peer and register the connection. Idempotent per peer: an
    /// existing live connection is reused.
    pub async fn connect(&self, addr: EndpointAddr) -> Result<()> {
        let peer = addr.id;
        if self.conns.lock().unwrap().contains_key(&peer) {
            return Ok(());
        }
        let conn = self
            .endpoint()
            .connect(addr, ALPN)
            .await
            .context("failed to connect to peer")?;
        register_connection(conn, self.conns.clone(), self.events.clone());
        Ok(())
    }

    /// Send one message to one peer (one uni stream per message).
    pub async fn send(&self, peer: EndpointId, payload: String) -> Result<()> {
        anyhow::ensure!(
            payload.len() <= MAX_MESSAGE_SIZE,
            "message too large (max {MAX_MESSAGE_SIZE} bytes)"
        );
        let conn = self
            .conns
            .lock()
            .unwrap()
            .get(&peer)
            .cloned()
            .context("no live connection to peer")?;
        send_on(&conn, &payload).await
    }

    /// Send one message to every connected peer. Returns how many peers the
    /// message was written to.
    pub async fn broadcast(&self, payload: String) -> Result<usize> {
        anyhow::ensure!(
            payload.len() <= MAX_MESSAGE_SIZE,
            "message too large (max {MAX_MESSAGE_SIZE} bytes)"
        );
        let conns: Vec<(EndpointId, Connection)> = {
            let map = self.conns.lock().unwrap();
            map.iter().map(|(id, c)| (*id, c.clone())).collect()
        };
        let mut sent = 0;
        for (_, conn) in &conns {
            if send_on(conn, &payload).await.is_ok() {
                sent += 1;
            }
        }
        Ok(sent)
    }

    pub fn peers(&self) -> Vec<EndpointId> {
        self.conns.lock().unwrap().keys().copied().collect()
    }

    pub async fn close(&self) {
        let conns: Vec<Connection> = self.conns.lock().unwrap().values().cloned().collect();
        for conn in conns {
            conn.close(0u8.into(), b"leaving");
        }
        self.router.shutdown().await.ok();
    }
}

async fn send_on(conn: &Connection, payload: &str) -> Result<()> {
    let mut stream = conn.open_uni().await?;
    stream.write_all(payload.as_bytes()).await?;
    stream.finish()?;
    // Deliberately NOT awaiting stream.stopped(): that would block until the
    // receiver acks, so one wedged peer could stall a broadcast loop for
    // everyone behind it. Delivery is best-effort — quinn flushes the
    // finished stream as long as the connection stays open.
    Ok(())
}

/// Insert the connection into the registry and spawn its receive loop.
/// Used for both dialed and accepted connections.
fn register_connection(conn: Connection, conns: ConnMap, events: broadcast::Sender<Event>) {
    let peer = conn.remote_id();
    let previous = conns.lock().unwrap().insert(peer, conn.clone());
    if let Some(prev) = previous {
        // Simultaneous dial from both sides: keep the newest, drop the old.
        prev.close(0u8.into(), b"superseded");
    } else {
        events.send(Event::PeerConnected { peer }).ok();
    }

    task::spawn(async move {
        let err = recv_loop(&conn, peer, &events).await.err();
        // Only deregister if we are still the registered connection —
        // a superseding connection may already have replaced us.
        let mut map = conns.lock().unwrap();
        let still_registered = map
            .get(&peer)
            .map(|c| c.stable_id() == conn.stable_id())
            .unwrap_or(false);
        if still_registered {
            map.remove(&peer);
            drop(map);
            events
                .send(Event::PeerDisconnected {
                    peer,
                    error: err.map(|e| e.to_string()),
                })
                .ok();
        }
    });
}

async fn recv_loop(
    conn: &Connection,
    peer: EndpointId,
    events: &broadcast::Sender<Event>,
) -> Result<()> {
    loop {
        let mut stream = conn.accept_uni().await?;
        // Per-message isolation: an oversized or non-utf8 message is dropped,
        // never allowed to kill the connection. Connection-level failures
        // resurface through accept_uni on the next iteration.
        let Ok(bytes) = stream.read_to_end(MAX_MESSAGE_SIZE).await else {
            continue;
        };
        let Ok(payload) = String::from_utf8(bytes) else {
            continue;
        };
        events
            .send(Event::Message {
                from: peer,
                payload,
            })
            .ok();
    }
}

#[derive(Debug, Clone)]
struct MpProtocol {
    conns: ConnMap,
    events: broadcast::Sender<Event>,
}

impl ProtocolHandler for MpProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        register_connection(connection.clone(), self.conns.clone(), self.events.clone());
        // Keep the handler task alive until the connection ends; the receive
        // loop spawned by `register_connection` does the actual work.
        connection.closed().await;
        Ok(())
    }
}
