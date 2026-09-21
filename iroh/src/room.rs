//! Ephemeral multiplayer room state over iroh-docs + iroh-gossip.
//!
//! A room is an iroh-docs namespace synced over a gossip swarm: writers hold
//! the namespace secret, spectators hold only the namespace id (read
//! capability). Every replica lives in memory — when the last participant
//! closes their tab the room's state ceases to exist anywhere. The Maypop
//! backend is not involved beyond rendezvous (bootstrap peers) and handing
//! out the namespace key.
//!
//! Late joiners sync the current entries from whichever peers are alive
//! (set reconciliation), then keep receiving updates through the swarm.

use std::sync::Mutex;

use anyhow::{Context, Result};
use iroh::protocol::Router;
use iroh::{Endpoint, EndpointAddr};
use iroh_blobs::BlobsProtocol;
use iroh_blobs::store::mem::MemStore;
use iroh_docs::api::Doc;
use iroh_docs::engine::LiveEvent;
use iroh_docs::protocol::Docs;
use iroh_docs::store::Query;
use iroh_docs::{AuthorId, Capability, NamespaceId, NamespaceSecret};
use iroh_gossip::net::Gossip;
use n0_future::StreamExt;
use serde::Serialize;

/// One entry in the room doc, resolved to its content, as handed to JS.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomEntry {
    pub key: String,
    /// UTF-8 content (the SDK stores JSON strings).
    pub value: String,
    /// The writer's timestamp (microseconds, sender clock) — used only for
    /// LWW resolution inside docs, not for presence.
    pub timestamp: u64,
    pub author: String,
}

/// Doc lifecycle events surfaced to JS. The SDK treats every variant as
/// "re-read entries", so this carries no payload beyond the type.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RoomEvent {
    Changed,
    SyncFinished,
    NeighborUp,
    NeighborDown,
}

pub struct RoomNode {
    router: Router,
    blobs: MemStore,
    docs: Docs,
    doc: Mutex<Option<Doc>>,
    author: Mutex<Option<AuthorId>>,
}

impl RoomNode {
    pub async fn spawn() -> Result<Self> {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .bind()
            .await?;
        let blobs = MemStore::default();
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await?;
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .accept(iroh_gossip::ALPN, gossip)
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();
        Ok(Self {
            router,
            blobs,
            docs,
            doc: Mutex::new(None),
            author: Mutex::new(None),
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    /// Wait until we are reachable via a relay, then return our dialable
    /// address for the rendezvous.
    pub async fn dialable_addr(&self) -> Result<EndpointAddr> {
        let endpoint = self.endpoint().clone();
        endpoint.online().await;
        Ok(endpoint.addr())
    }

    /// Join the room's namespace with the given capability and start syncing
    /// with the bootstrap peers.
    pub async fn join(&self, capability: Capability, bootstrap: Vec<EndpointAddr>) -> Result<()> {
        let doc = self.docs.api().import_namespace(capability).await?;
        let author = self.docs.api().author_default().await?;
        doc.set_download_policy(iroh_docs::store::DownloadPolicy::EverythingExcept(vec![]))
            .await
            .ok();
        // Always start the live sync — even with no bootstrap peers. This is
        // what subscribes the namespace to the gossip swarm AND marks it
        // live for INCOMING sync; without it the first peer in a room
        // rejects joiners with `RemoteAbort(NotFound)`.
        doc.start_sync(bootstrap).await?;
        *self.doc.lock().unwrap() = Some(doc);
        *self.author.lock().unwrap() = Some(author);
        Ok(())
    }

    fn doc(&self) -> Result<Doc> {
        self.doc.lock().unwrap().clone().context("room not joined")
    }

    /// Sync with additional peers discovered after the initial join.
    pub async fn add_peers(&self, peers: Vec<EndpointAddr>) -> Result<()> {
        if peers.is_empty() {
            return Ok(());
        }
        self.doc()?.start_sync(peers).await
    }

    /// Write one key (UTF-8 value; the SDK stores JSON strings).
    pub async fn set(&self, key: String, value: String) -> Result<()> {
        let author = self.author.lock().unwrap().context("room not joined")?;
        self.doc()?
            .set_bytes(author, key.into_bytes(), value.into_bytes())
            .await?;
        Ok(())
    }

    /// Latest entry per key, with content resolved from the local blob
    /// store. Entries whose content hasn't been downloaded yet are skipped —
    /// a ContentReady event will trigger a re-read.
    pub async fn entries(&self) -> Result<Vec<RoomEntry>> {
        let doc = self.doc()?;
        let mut stream = Box::pin(doc.get_many(Query::single_latest_per_key()).await?);
        let mut out = Vec::new();
        while let Some(entry) = stream.next().await {
            let entry = entry?;
            let Ok(bytes) = self.blobs.blobs().get_bytes(entry.content_hash()).await else {
                continue;
            };
            let Ok(value) = String::from_utf8(bytes.to_vec()) else {
                continue;
            };
            let Ok(key) = String::from_utf8(entry.key().to_vec()) else {
                continue;
            };
            out.push(RoomEntry {
                key,
                value,
                timestamp: entry.timestamp(),
                author: entry.author().to_string(),
            });
        }
        Ok(out)
    }

    /// The room's live event stream, mapped down to "something changed"
    /// granularity (the SDK re-reads `entries` on every event).
    pub async fn events(&self) -> Result<impl n0_future::Stream<Item = RoomEvent> + Unpin> {
        let doc = self.doc()?;
        let stream = doc.subscribe().await?;
        Ok(Box::pin(stream.filter_map(|event| {
            let event = event.ok()?;
            Some(match event {
                LiveEvent::InsertLocal { .. }
                | LiveEvent::InsertRemote { .. }
                | LiveEvent::ContentReady { .. }
                | LiveEvent::PendingContentReady => RoomEvent::Changed,
                LiveEvent::SyncFinished(_) => RoomEvent::SyncFinished,
                LiveEvent::NeighborUp(_) => RoomEvent::NeighborUp,
                LiveEvent::NeighborDown(_) => RoomEvent::NeighborDown,
            })
        })))
    }

    pub async fn close(&self) {
        let doc = self.doc.lock().unwrap().take();
        if let Some(doc) = doc {
            doc.leave().await.ok();
            doc.close().await.ok();
        }
        self.router.shutdown().await.ok();
    }
}

/// Parse a hex-encoded 32-byte namespace secret into a write capability.
pub fn write_capability(secret_hex: &str) -> Result<Capability> {
    let bytes = parse_32(secret_hex).context("bad namespace secret")?;
    Ok(Capability::Write(NamespaceSecret::from_bytes(&bytes)))
}

/// Parse a hex-encoded 32-byte namespace id into a read capability.
pub fn read_capability(id_hex: &str) -> Result<Capability> {
    let bytes = parse_32(id_hex).context("bad namespace id")?;
    Ok(Capability::Read(NamespaceId::from(bytes)))
}

fn parse_32(hex: &str) -> Result<[u8; 32]> {
    anyhow::ensure!(hex.len() == 64, "expected 64 hex chars");
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk)?;
        out[i] = u8::from_str_radix(s, 16)?;
    }
    Ok(out)
}
