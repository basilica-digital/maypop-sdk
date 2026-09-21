//! Gossip swarm transport for large multiplayer sessions.
//!
//! Unlike the full mesh in `node.rs` (one connection per peer pair), a swarm
//! session joins an iroh-gossip topic: each participant keeps a handful of
//! active connections regardless of room size, and broadcasts propagate
//! epidemically along broadcast trees. Payloads travel INSIDE the gossip
//! messages (no metadata-then-fetch round trip like iroh-docs), so bursts
//! stream at wire speed.
//!
//! Identity note: gossip relays messages, so the delivering peer is NOT the
//! origin. Origin identity is an SDK-layer envelope field, sender-claimed —
//! the same trust level as everything else members exchange in a room.

use std::sync::Mutex;

use anyhow::{Context, Result};
use bytes::Bytes;
use iroh::address_lookup::memory::MemoryLookup;
use iroh::protocol::Router;
use iroh::{Endpoint, EndpointAddr};
use iroh_gossip::api::{Event as GossipEvent, GossipReceiver, GossipSender};
use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use n0_future::StreamExt;
use serde::Serialize;

/// Generous for JSON game payloads, small enough to keep the swarm healthy.
/// (Gossip messages are relayed by peers; big blobs belong on the mesh.)
const MAX_MESSAGE_SIZE: usize = 32 * 1024;

/// Events surfaced to JS from the swarm.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SwarmEvent {
    /// A broadcast arrived. `payload` is the raw UTF-8 message (the SDK's
    /// envelope); `deliveredFrom` is the relaying neighbor, NOT the origin.
    Message {
        payload: String,
        delivered_from: String,
    },
    NeighborUp {
        peer: String,
    },
    NeighborDown {
        peer: String,
    },
    /// The receiver fell behind and messages were dropped.
    Lagged,
}

pub struct SwarmNode {
    router: Router,
    gossip: Gossip,
    lookup: MemoryLookup,
    sender: Mutex<Option<GossipSender>>,
    receiver: Mutex<Option<GossipReceiver>>,
}

impl SwarmNode {
    pub async fn spawn() -> Result<Self> {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .bind()
            .await?;
        let gossip = Gossip::builder()
            .max_message_size(MAX_MESSAGE_SIZE)
            .spawn(endpoint.clone());
        // Rendezvous hands us full addresses; gossip dials by endpoint id.
        // A memory lookup bridges the two (same pattern iroh-docs uses).
        let lookup = MemoryLookup::new();
        endpoint.address_lookup()?.add(lookup.clone());
        let router = Router::builder(endpoint)
            .accept(iroh_gossip::ALPN, gossip.clone())
            .spawn();
        Ok(Self {
            router,
            gossip,
            lookup,
            sender: Mutex::new(None),
            receiver: Mutex::new(None),
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    pub async fn dialable_addr(&self) -> Result<EndpointAddr> {
        let endpoint = self.endpoint().clone();
        endpoint.online().await;
        Ok(endpoint.addr())
    }

    /// Subscribe to the topic and start joining the bootstrap peers. Returns
    /// immediately — the first peer of an empty room has nobody to join yet,
    /// and outgoing broadcasts queue until a neighbor connects.
    pub async fn join(&self, topic: [u8; 32], bootstrap: Vec<EndpointAddr>) -> Result<()> {
        let ids = bootstrap.iter().map(|a| a.id).collect();
        for addr in bootstrap {
            self.lookup.add_endpoint_info(addr);
        }
        let sub = self
            .gossip
            .subscribe(TopicId::from_bytes(topic), ids)
            .await?;
        let (sender, receiver) = sub.split();
        *self.sender.lock().unwrap() = Some(sender);
        *self.receiver.lock().unwrap() = Some(receiver);
        Ok(())
    }

    /// Feed newly-discovered peers into the swarm's membership.
    pub async fn join_peers(&self, peers: Vec<EndpointAddr>) -> Result<()> {
        if peers.is_empty() {
            return Ok(());
        }
        let ids: Vec<_> = peers.iter().map(|a| a.id).collect();
        for addr in peers {
            self.lookup.add_endpoint_info(addr);
        }
        let sender = self
            .sender
            .lock()
            .unwrap()
            .clone()
            .context("swarm not joined")?;
        sender.join_peers(ids).await?;
        Ok(())
    }

    /// Broadcast one message to the whole topic.
    pub async fn broadcast(&self, payload: String) -> Result<()> {
        anyhow::ensure!(
            payload.len() <= MAX_MESSAGE_SIZE,
            "message too large (max {MAX_MESSAGE_SIZE} bytes)"
        );
        let sender = self
            .sender
            .lock()
            .unwrap()
            .clone()
            .context("swarm not joined")?;
        sender.broadcast(Bytes::from(payload)).await?;
        Ok(())
    }

    /// The topic's event stream. Single consumer: takes the receiver.
    pub fn events(&self) -> Result<impl n0_future::Stream<Item = SwarmEvent> + Unpin> {
        let receiver = self
            .receiver
            .lock()
            .unwrap()
            .take()
            .context("swarm not joined (or events already taken)")?;
        Ok(Box::pin(receiver.filter_map(|event| {
            let event = event.ok()?;
            Some(match event {
                GossipEvent::Received(msg) => SwarmEvent::Message {
                    payload: String::from_utf8(msg.content.to_vec()).ok()?,
                    delivered_from: msg.delivered_from.to_string(),
                },
                GossipEvent::NeighborUp(peer) => SwarmEvent::NeighborUp {
                    peer: peer.to_string(),
                },
                GossipEvent::NeighborDown(peer) => SwarmEvent::NeighborDown {
                    peer: peer.to_string(),
                },
                GossipEvent::Lagged => SwarmEvent::Lagged,
            })
        })))
    }

    pub async fn close(&self) {
        *self.sender.lock().unwrap() = None;
        self.router.shutdown().await.ok();
    }
}
