/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export class MpNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Send one message to every connected peer; returns the peer count
     * the message was written to.
     */
    broadcast(payload: string): Promise<number>;
    /**
     * Close all connections and shut the endpoint down.
     */
    close(): Promise<void>;
    /**
     * Dial a peer by the address JSON it published to the rendezvous.
     */
    connect(addr_json: string): Promise<void>;
    /**
     * Wait until we are reachable via a relay, then return our dialable
     * address as JSON — this is what gets published to the rendezvous.
     */
    dialableAddr(): Promise<string>;
    /**
     * This node's endpoint id (stable public key, hex).
     */
    endpointId(): string;
    /**
     * One stream of `{type: "peerConnected"|"message"|"peerDisconnected"}`
     * events, serialized for JS consumption.
     */
    events(): ReadableStream;
    /**
     * Endpoint ids of currently connected peers.
     */
    peers(): string[];
    /**
     * Send one message to one connected peer (endpoint id string).
     */
    send(peer: string, payload: string): Promise<void>;
    /**
     * Create an endpoint and start accepting peer connections.
     */
    static spawn(): Promise<MpNode>;
}

/**
 * An ephemeral multiplayer room: iroh-docs state synced over gossip.
 * One per `maypop.multiplayer.join()`; nothing persists anywhere once the
 * last participant closes it.
 */
export class RoomNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Sync with additional peers discovered after the initial join.
     */
    addPeers(addrs_json: string): Promise<void>;
    /**
     * Leave the doc and shut everything down. The replica is gone after
     * this — state only survives in still-open peers.
     */
    close(): Promise<void>;
    /**
     * Wait until reachable via a relay, then return our dialable address
     * JSON for the rendezvous announce.
     */
    dialableAddr(): Promise<string>;
    /**
     * This node's endpoint id (for filtering self out of the rendezvous).
     */
    endpointId(): string;
    /**
     * Latest entry per key as a JSON array of
     * `{key, value, timestamp, author}`.
     */
    entries(): Promise<string>;
    /**
     * Stream of `{type: "changed"|"syncFinished"|"neighborUp"|"neighborDown"}`
     * events; re-read `entries()` on any of them.
     */
    events(): Promise<ReadableStream>;
    /**
     * Join as a read-only spectator (64-char hex namespace id).
     */
    joinRead(id_hex: string, bootstrap_json: string): Promise<void>;
    /**
     * Join as a writer (64-char hex namespace secret).
     */
    joinWrite(secret_hex: string, bootstrap_json: string): Promise<void>;
    /**
     * Write one key (the SDK stores JSON strings as values).
     */
    set(key: string, value: string): Promise<void>;
    /**
     * Create the endpoint + gossip + docs stack (memory stores only).
     */
    static spawn(): Promise<RoomNode>;
}

/**
 * A gossip-swarm session for large rooms: each participant keeps a handful
 * of connections regardless of room size; broadcasts carry their payload
 * and propagate epidemically (burst-friendly, unlike docs entries).
 */
export class SwarmNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Broadcast one message (≤32KB) to the whole topic.
     */
    broadcast(payload: string): Promise<void>;
    /**
     * Leave the topic and shut the endpoint down.
     */
    close(): Promise<void>;
    /**
     * Wait until reachable via a relay, then return our dialable address
     * JSON for the rendezvous announce.
     */
    dialableAddr(): Promise<string>;
    /**
     * This node's endpoint id.
     */
    endpointId(): string;
    /**
     * Stream of `{type: "message"|"neighborUp"|"neighborDown"|"lagged"}`
     * events. Single consumer; `message.deliveredFrom` is the relaying
     * neighbor, NOT the origin.
     */
    events(): ReadableStream;
    /**
     * Subscribe to a topic (64-char hex topic id) and start joining the
     * bootstrap peers. Non-blocking: an empty room joins instantly.
     */
    join(topic_hex: string, bootstrap_json: string): Promise<void>;
    /**
     * Feed newly-discovered peers into the swarm's membership.
     */
    joinPeers(addrs_json: string): Promise<void>;
    /**
     * Create the endpoint + gossip stack.
     */
    static spawn(): Promise<SwarmNode>;
}

/**
 * Route the crate's tracing output to the browser console. Optional —
 * call before spawning nodes, with an EnvFilter directive like
 * `"warn"` or `"iroh_docs=debug,iroh_blobs=debug"`. One-shot: later
 * calls are ignored (the global subscriber can only be set once).
 */
export function initLogging(filter: string): void;

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mpnode_free: (a: number, b: number) => void;
    readonly __wbg_roomnode_free: (a: number, b: number) => void;
    readonly __wbg_swarmnode_free: (a: number, b: number) => void;
    readonly initLogging: (a: number, b: number) => void;
    readonly mpnode_broadcast: (a: number, b: number, c: number) => number;
    readonly mpnode_close: (a: number) => number;
    readonly mpnode_connect: (a: number, b: number, c: number) => number;
    readonly mpnode_dialableAddr: (a: number) => number;
    readonly mpnode_endpointId: (a: number, b: number) => void;
    readonly mpnode_events: (a: number) => number;
    readonly mpnode_peers: (a: number, b: number) => void;
    readonly mpnode_send: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly mpnode_spawn: () => number;
    readonly roomnode_addPeers: (a: number, b: number, c: number) => number;
    readonly roomnode_close: (a: number) => number;
    readonly roomnode_dialableAddr: (a: number) => number;
    readonly roomnode_endpointId: (a: number, b: number) => void;
    readonly roomnode_entries: (a: number) => number;
    readonly roomnode_events: (a: number) => number;
    readonly roomnode_joinRead: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly roomnode_joinWrite: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly roomnode_set: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly roomnode_spawn: () => number;
    readonly start: () => void;
    readonly swarmnode_broadcast: (a: number, b: number, c: number) => number;
    readonly swarmnode_close: (a: number) => number;
    readonly swarmnode_dialableAddr: (a: number) => number;
    readonly swarmnode_endpointId: (a: number, b: number) => void;
    readonly swarmnode_events: (a: number, b: number) => void;
    readonly swarmnode_join: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly swarmnode_joinPeers: (a: number, b: number, c: number) => number;
    readonly swarmnode_spawn: () => number;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wasm_bindgen_func_elem_27365: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_27379: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_18125: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_14591: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_19802: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_17908: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_19053: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_19089: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_27233: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
