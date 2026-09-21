//! Wasm bindings for the Maypop iroh multiplayer node.
//!
//! Compiled to `wasm32-unknown-unknown` and loaded lazily by the embedded-app
//! SDK (`window.maypop`). The JS surface is intentionally tiny: spawn a node,
//! publish its address through the Maypop rendezvous, dial peers, exchange
//! string messages, observe everything through one ReadableStream of events.

mod node;
mod room;
mod swarm;

use anyhow::Context;
use iroh::EndpointAddr;
use n0_future::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use wasm_bindgen::JsError;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_streams::ReadableStream;
use wasm_streams::readable::sys::ReadableStream as JsReadableStream;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// Route the crate's tracing output to the browser console. Optional —
/// call before spawning nodes, with an EnvFilter directive like
/// `"warn"` or `"iroh_docs=debug,iroh_blobs=debug"`. One-shot: later
/// calls are ignored (the global subscriber can only be set once).
#[wasm_bindgen(js_name = initLogging)]
pub fn init_logging(filter: String) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let Ok(filter) = tracing_subscriber::EnvFilter::try_new(filter) else {
        return;
    };
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .without_time()
                .with_writer(tracing_subscriber_wasm::MakeConsoleWriter::default()),
        )
        .try_init()
        .ok();
}

#[wasm_bindgen]
pub struct MpNode(node::MpNode);

#[wasm_bindgen]
impl MpNode {
    /// Create an endpoint and start accepting peer connections.
    pub async fn spawn() -> Result<MpNode, JsError> {
        Ok(Self(node::MpNode::spawn().await.map_err(to_js_err)?))
    }

    /// This node's endpoint id (stable public key, hex).
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.0.endpoint().id().to_string()
    }

    /// Wait until we are reachable via a relay, then return our dialable
    /// address as JSON — this is what gets published to the rendezvous.
    #[wasm_bindgen(js_name = dialableAddr)]
    pub async fn dialable_addr(&self) -> Result<String, JsError> {
        let addr = self.0.dialable_addr().await.map_err(to_js_err)?;
        serde_json::to_string(&addr).map_err(|e| to_js_err(anyhow::Error::from(e)))
    }

    /// One stream of `{type: "peerConnected"|"message"|"peerDisconnected"}`
    /// events, serialized for JS consumption.
    pub fn events(&self) -> JsReadableStream {
        let stream = BroadcastStream::new(self.0.subscribe()).filter_map(|event| event.ok());
        let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
        ReadableStream::from_stream(stream).into_raw()
    }

    /// Dial a peer by the address JSON it published to the rendezvous.
    pub async fn connect(&self, addr_json: String) -> Result<(), JsError> {
        let addr: EndpointAddr = serde_json::from_str(&addr_json)
            .context("bad peer address")
            .map_err(to_js_err)?;
        self.0.connect(addr).await.map_err(to_js_err)
    }

    /// Send one message to one connected peer (endpoint id string).
    pub async fn send(&self, peer: String, payload: String) -> Result<(), JsError> {
        let peer = peer.parse().context("bad endpoint id").map_err(to_js_err)?;
        self.0.send(peer, payload).await.map_err(to_js_err)
    }

    /// Send one message to every connected peer; returns the peer count
    /// the message was written to.
    pub async fn broadcast(&self, payload: String) -> Result<u32, JsError> {
        Ok(self.0.broadcast(payload).await.map_err(to_js_err)? as u32)
    }

    /// Endpoint ids of currently connected peers.
    pub fn peers(&self) -> Vec<String> {
        self.0.peers().iter().map(|p| p.to_string()).collect()
    }

    /// Close all connections and shut the endpoint down.
    pub async fn close(&self) {
        self.0.close().await;
    }
}

/// An ephemeral multiplayer room: iroh-docs state synced over gossip.
/// One per `maypop.multiplayer.join()`; nothing persists anywhere once the
/// last participant closes it.
#[wasm_bindgen]
pub struct RoomNode(room::RoomNode);

#[wasm_bindgen]
impl RoomNode {
    /// Create the endpoint + gossip + docs stack (memory stores only).
    pub async fn spawn() -> Result<RoomNode, JsError> {
        Ok(Self(room::RoomNode::spawn().await.map_err(to_js_err)?))
    }

    /// This node's endpoint id (for filtering self out of the rendezvous).
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.0.endpoint().id().to_string()
    }

    /// Wait until reachable via a relay, then return our dialable address
    /// JSON for the rendezvous announce.
    #[wasm_bindgen(js_name = dialableAddr)]
    pub async fn dialable_addr(&self) -> Result<String, JsError> {
        let addr = self.0.dialable_addr().await.map_err(to_js_err)?;
        serde_json::to_string(&addr).map_err(|e| to_js_err(anyhow::Error::from(e)))
    }

    /// Join as a writer (64-char hex namespace secret).
    #[wasm_bindgen(js_name = joinWrite)]
    pub async fn join_write(
        &self,
        secret_hex: String,
        bootstrap_json: String,
    ) -> Result<(), JsError> {
        let cap = room::write_capability(&secret_hex).map_err(to_js_err)?;
        let peers = parse_addrs(&bootstrap_json)?;
        self.0.join(cap, peers).await.map_err(to_js_err)
    }

    /// Join as a read-only spectator (64-char hex namespace id).
    #[wasm_bindgen(js_name = joinRead)]
    pub async fn join_read(&self, id_hex: String, bootstrap_json: String) -> Result<(), JsError> {
        let cap = room::read_capability(&id_hex).map_err(to_js_err)?;
        let peers = parse_addrs(&bootstrap_json)?;
        self.0.join(cap, peers).await.map_err(to_js_err)
    }

    /// Sync with additional peers discovered after the initial join.
    #[wasm_bindgen(js_name = addPeers)]
    pub async fn add_peers(&self, addrs_json: String) -> Result<(), JsError> {
        let peers = parse_addrs(&addrs_json)?;
        self.0.add_peers(peers).await.map_err(to_js_err)
    }

    /// Write one key (the SDK stores JSON strings as values).
    pub async fn set(&self, key: String, value: String) -> Result<(), JsError> {
        self.0.set(key, value).await.map_err(to_js_err)
    }

    /// Latest entry per key as a JSON array of
    /// `{key, value, timestamp, author}`.
    pub async fn entries(&self) -> Result<String, JsError> {
        let entries = self.0.entries().await.map_err(to_js_err)?;
        serde_json::to_string(&entries).map_err(|e| to_js_err(anyhow::Error::from(e)))
    }

    /// Stream of `{type: "changed"|"syncFinished"|"neighborUp"|"neighborDown"}`
    /// events; re-read `entries()` on any of them.
    pub async fn events(&self) -> Result<JsReadableStream, JsError> {
        let stream = self.0.events().await.map_err(to_js_err)?;
        let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
        Ok(ReadableStream::from_stream(stream).into_raw())
    }

    /// Leave the doc and shut everything down. The replica is gone after
    /// this — state only survives in still-open peers.
    pub async fn close(&self) {
        self.0.close().await;
    }
}

/// A gossip-swarm session for large rooms: each participant keeps a handful
/// of connections regardless of room size; broadcasts carry their payload
/// and propagate epidemically (burst-friendly, unlike docs entries).
#[wasm_bindgen]
pub struct SwarmNode(swarm::SwarmNode);

#[wasm_bindgen]
impl SwarmNode {
    /// Create the endpoint + gossip stack.
    pub async fn spawn() -> Result<SwarmNode, JsError> {
        Ok(Self(swarm::SwarmNode::spawn().await.map_err(to_js_err)?))
    }

    /// This node's endpoint id.
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.0.endpoint().id().to_string()
    }

    /// Wait until reachable via a relay, then return our dialable address
    /// JSON for the rendezvous announce.
    #[wasm_bindgen(js_name = dialableAddr)]
    pub async fn dialable_addr(&self) -> Result<String, JsError> {
        let addr = self.0.dialable_addr().await.map_err(to_js_err)?;
        serde_json::to_string(&addr).map_err(|e| to_js_err(anyhow::Error::from(e)))
    }

    /// Subscribe to a topic (64-char hex topic id) and start joining the
    /// bootstrap peers. Non-blocking: an empty room joins instantly.
    pub async fn join(&self, topic_hex: String, bootstrap_json: String) -> Result<(), JsError> {
        let topic = parse_topic(&topic_hex)?;
        let peers = parse_addrs(&bootstrap_json)?;
        self.0.join(topic, peers).await.map_err(to_js_err)
    }

    /// Feed newly-discovered peers into the swarm's membership.
    #[wasm_bindgen(js_name = joinPeers)]
    pub async fn join_peers(&self, addrs_json: String) -> Result<(), JsError> {
        let peers = parse_addrs(&addrs_json)?;
        self.0.join_peers(peers).await.map_err(to_js_err)
    }

    /// Broadcast one message (≤32KB) to the whole topic.
    pub async fn broadcast(&self, payload: String) -> Result<(), JsError> {
        self.0.broadcast(payload).await.map_err(to_js_err)
    }

    /// Stream of `{type: "message"|"neighborUp"|"neighborDown"|"lagged"}`
    /// events. Single consumer; `message.deliveredFrom` is the relaying
    /// neighbor, NOT the origin.
    pub fn events(&self) -> Result<JsReadableStream, JsError> {
        let stream = self.0.events().map_err(to_js_err)?;
        let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
        Ok(ReadableStream::from_stream(stream).into_raw())
    }

    /// Leave the topic and shut the endpoint down.
    pub async fn close(&self) {
        self.0.close().await;
    }
}

fn parse_topic(hex: &str) -> Result<[u8; 32], JsError> {
    if hex.len() != 64 {
        return Err(JsError::new("topic id must be 64 hex chars"));
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).map_err(|e| JsError::new(&e.to_string()))?;
        out[i] = u8::from_str_radix(s, 16).map_err(|e| JsError::new(&e.to_string()))?;
    }
    Ok(out)
}

fn parse_addrs(json: &str) -> Result<Vec<iroh::EndpointAddr>, JsError> {
    serde_json::from_str(json)
        .context("bad peer address list")
        .map_err(to_js_err)
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}
