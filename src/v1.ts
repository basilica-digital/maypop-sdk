/**
 * window.maypop — typed reference for the Maypop embedded-app SDK (v1).
 *
 * This is the SOURCE OF TRUTH for the SDK's public surface. It is served at
 * `/sdk/v1.d.ts` (next to the runtime `/sdk/v1.js`) so two audiences consume
 * the exact same contract:
 *   1. app developers — drop it into an editor for autocomplete + type checks;
 *   2. the Maypop Studio model — fetched on demand to write correct app code.
 *
 * The API is CUSTOM and cannot be guessed from generic web knowledge — the
 * names and shapes below are specific to Maypop. Read the JSDoc, don't infer.
 *
 * ## Loading the SDK
 *
 * The host never injects anything into your bundle — you opt in by adding the
 * script tag yourself, pointing at the Maypop API origin (NOT a relative path:
 * on a per-app origin `/sdk/v1.js` would resolve to a file inside your own
 * bundle):
 *
 * ```html
 * <script src="https://api.dev.maypop.ai/sdk/v1.js"></script>
 * ```
 *
 * It defines a frozen global `window.maypop`. Nothing is usable until the host
 * handshake completes — always `await maypop.ready()` first.
 *
 * ## Everything is attached, everywhere
 *
 * There is no sandbox or preview mode. Wherever an app runs — including the
 * Studio's live preview while it is being built — it holds a real session
 * against a real app: its own database and file storage, AI, notifications,
 * and any connected integrations. What the app saves is really saved. When no
 * session is available at all, `ready()` stays pending rather than resolving
 * against a local stand-in.
 */

declare global {
  interface Window {
    /** The Maypop SDK, present once `/sdk/v1.js` has loaded. */
    maypop: Maypop;
  }
}

/** The lifecycle/identity events `maypop.on` can subscribe to. */
type MaypopEvent =
  /**
   * The viewer's permissions changed at runtime — typically a read-only
   * session being upgraded to read-write (or vice versa). Re-read
   * `maypop.mode` / `maypop.permissions` and update any gated UI.
   */
  | "modechange"
  /**
   * The session was revoked (host kicked it, membership lost, refresh
   * rejected). Calls into the backend will now reject; tear down or show a
   * "disconnected" state.
   */
  | "revoked"
  /**
   * The host UI's light/dark theme changed. The SDK has already mirrored the
   * new value onto `<html data-theme>` and `color-scheme` (app styles can
   * target that attribute); subscribe only to update visuals you render
   * yourself (canvas, charts). Read the new value from `maypop.theme`.
   */
  | "themechange";

/** Coarse capability mode, derived from whether `kv:write` was granted. */
type MaypopMode = "read-write" | "read-only";

/** The host UI's color theme, as reported over `maypop:theme` messages. */
type MaypopTheme = "light" | "dark";

// #region capability:identity

/**
 * The current viewer, as the app is allowed to see them — a PSEUDONYMOUS
 * identity. `id` is stable for this viewer within this app instance but is NOT
 * the person's real Maypop user id, and differs across apps. Available after
 * `ready()`.
 */
interface MaypopUser {
  /**
   * Pseudonymous, app-scoped viewer id (UUID). Stable per viewer per app
   * instance; safe to use as a key for per-user data. Never the real user id.
   */
  id: string;
  /** Display name. */
  username: string;
  /**
   * What this viewer may do with the app: `"admin"`, `"editor"`, `"writer"`,
   * or `"reader"`. The app's author is always `"admin"`; anyone else gets the
   * strongest role granted by the groups the app is shared into. A viewer who
   * opened the app through a share link is always `"reader"`, whatever their
   * standing elsewhere.
   *
   * A hint for labels and optional UI — never your own permission check. The
   * server decides what a caller may actually do.
   */
  role: string;
  /** Avatar URL, or null if none. */
  avatarUrl: string | null;
  /** Whether the viewer is currently connected. */
  connected: boolean;
  /**
   * True when the viewer has no Maypop identity at all — a share-link visitor
   * who wasn't signed in. A signed-in visitor on a share link is *not*
   * anonymous (`username` and `avatarUrl` are real) but is still a read-only
   * guest, so gate write UI on {@link Maypop.mode}, never on this.
   */
  isAnonymous: boolean;
  /** Space-separated granted scopes (same data as `maypop.permissions`). */
  scopes: string;
}

/** Which app the iframe is running as. Null before `ready()`. */
interface MaypopAppContext {
  /**
   * The app's id — its identity, independent of any group.
   */
  id?: string;
}

// #endregion capability:identity

// #region capability:kv

/** One entry in the app's KV store, as returned by `list` / `subscribe`. */
interface MaypopKvEntry {
  /** The entry's key. */
  key: string;
  /** The stored value — whatever was written (must be JSON-serializable). */
  value: unknown;
  /**
   * Pseudonymous id of the viewer who last wrote this entry, or null. Matches
   * a `MaypopUser.id` — compare with `maypop.user.id` to find your own writes.
   */
  author: string | null;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
}

/**
 * The app's shared key-value store — one store per app, wherever it is opened
 * from. Everyone who can reach the app reads and writes the SAME store, so
 * this is how an app shares and syncs state across people.
 *
 * Local-first: a write applies locally at once and is reconciled with the
 * server last-write-wins, so concurrent writes to a key resolve to the last
 * one. Changes — your own and other members', the latter delivered over a live
 * poke stream — flow to `subscribe` callbacks.
 *
 * Keys under `~mp/` are reserved (older `maypop.multiplayer` rooms stored
 * session state there; rooms now sync peer-to-peer instead) and are hidden
 * from `list`/`subscribe` unless the prefix explicitly targets them — don't
 * write there yourself.
 */
interface MaypopKv {
  /**
   * Read one key, once. Resolves to the value, or null if absent.
   *
   * One-shot: it can resolve before the local store has finished hydrating or
   * before a remote write has synced in, so it may return null or a stale value
   * for data that exists or is about to arrive. Use it only for a true
   * point-in-time read; for anything you render or keep current, use
   * `subscribe`, which fires with the present value and again on every change.
   */
  get(key: string): Promise<unknown>;
  /**
   * Write one key. Requires the `kv:write` scope — throws `maypop/read-only`
   * for a read-only viewer, so gate write UI on `maypop.mode` (and listen for
   * `"modechange"`). The value must be JSON-serializable.
   *
   * The refusal is `maypop/sign-in-required` instead, and comes with a request
   * for the host's sign-in card, when signing in is all that stands in the
   * way. See {@link Maypop.signInRequired}.
   */
  set(key: string, value: unknown): Promise<void>;
  /** Delete one key. Requires `kv:write` (same read-only and sign-in rules as `set`). */
  delete(key: string): Promise<void>;
  /**
   * One-shot snapshot of entries whose key starts with `prefix` (default `""` =
   * every key), sorted by key.
   *
   * Like `get`, this can resolve before the store has hydrated or before remote
   * writes have synced in, so the snapshot may be empty or incomplete moments
   * after load. Use it for a one-time export or read; to populate and keep a
   * list in sync, use `subscribe` instead — it delivers the current entries and
   * re-fires as they load and change.
   */
  list(opts?: { prefix?: string }): Promise<MaypopKvEntry[]>;
  /**
   * Subscribe to entries matching `prefix`. The callback fires once with the
   * current matches, then again on every change (a local write, or another
   * member's via the poke stream). Returns an unsubscribe function.
   *
   * Prefer this over one-shot `get`/`list` for anything you render or keep
   * current: because it re-fires as data hydrates and syncs in, the UI fills in
   * automatically instead of being stuck with the empty/stale result of a read
   * that ran too early.
   *
   * ```js
   * const off = maypop.kv.subscribe("todo/", (entries) => render(entries));
   * // later: off();
   * ```
   */
  subscribe(prefix: string, cb: (entries: MaypopKvEntry[]) => void): () => void;
}

// #endregion capability:kv

// #region capability:drive

/** A file in the app's storage. */
interface MaypopDriveFile {
  /** Stable id of this drive file (UUID). */
  id: string;
  /** Content id — pass to `maypop.drive.url(cid)` / `delete(cid)`. */
  cid: string;
  /** Display name. */
  name: string;
  /** MIME type GCS recorded at upload, or null. */
  mimeType: string | null;
  /** Size in bytes, or null if unknown. */
  size: number | null;
  /**
   * Pseudonymous id of the member who uploaded it. Matches a `MaypopUser.id`.
   */
  uploadedBy: string;
  /** ISO-8601 upload timestamp. */
  createdAt: string;
}

/**
 * The app's private storage — durable files scoped to the current app.
 * Name-addressed files are immutable:
 * `write(name, content)` creates a new file and rejects if that name already
 * exists; use `read`/`readBlob` to read and `remove` to delete it.
 *
 * Bytes are stored in object storage; reads come back as short-lived signed
 * URLs you can drop into an `<img>`/`<video>` `src` or fetch directly. For
 * images specifically, prefer `imageUrl()` — it caches the bytes locally so
 * repeat loads of the same file are instant and work offline.
 *
 */
interface MaypopDrive {
  /** Maximum accepted size for one upload or write, in bytes (currently 50 MiB). */
  readonly maxUploadBytes: number;
  /**
   * List files in this app's storage. `opts.prefix` narrows to names beginning
   * with that path-like prefix. Requires `drive:read`; resolves to `[]`
   * without it.
   */
  list(opts?: { prefix?: string }): Promise<MaypopDriveFile[]>;
  /** File metadata by name, or `null` if it does not exist. */
  stat(name: string): Promise<MaypopDriveFile | null>;
  /** Read a file's content as text by name. Rejects `maypop/not-found`. */
  read(name: string): Promise<string>;
  /** Read a file's content as a `Blob` by name. Rejects `maypop/not-found`. */
  readBlob(name: string): Promise<Blob>;
  /**
   * Create a new file by name from a string, `Blob`, `ArrayBuffer`, or typed
   * array. Existing files are never overwritten: rejects `maypop/conflict` if
   * the name already exists. Also rejects `maypop/invalid-file` for an invalid
   * path-like name and `maypop/storage-full` when the app's storage is full.
   */
  write(
    name: string,
    content: string | Blob | ArrayBuffer | ArrayBufferView,
  ): Promise<MaypopDriveFile>;
  /**
   * Upload a `File`/`Blob` to this app's storage. Requires `drive:write` —
   * throws `maypop/read-only` for a read-only viewer, or
   * `maypop/sign-in-required` when a sign-in would grant it (see
   * {@link Maypop.signInRequired}). `opts.name` overrides the
   * display name (defaults to the file's name). Resolves to the created file.
   * Rejects with `code === "maypop/file-too-large"` before reading or sending
   * the Blob when `file.size` exceeds `maxUploadBytes`.
   *
   * ```js
   * const file = await maypop.drive.upload(input.files[0]);
   * img.src = await maypop.drive.imageUrl(file.cid); // use url() for non-image files
   * ```
   */
  upload(file: Blob, opts?: { name?: string }): Promise<MaypopDriveFile>;
  /**
   * A short-lived signed download URL for a file by `cid`. Requires
   * `drive:read`. The URL expires — fetch a fresh one rather than persisting it.
   */
  url(cid: string): Promise<string>;
  /**
   * Like `url()`, but for images: caches the bytes locally so a repeat load
   * of the same `cid` is instant and works offline, instead of re-signing +
   * re-fetching from GCS every call. Requires `drive:read`. Resolves to
   * either a same-origin path or an object URL (`blob:...`) depending on the
   * browser — either way, valid only for this page's lifetime: drop it
   * straight into an `<img>` `src`; don't persist or share it.
   *
   * ```js
   * const file = await maypop.drive.upload(input.files[0]);
   * img.src = await maypop.drive.imageUrl(file.cid);
   * ```
   */
  imageUrl(cid: string): Promise<string>;
  /** Delete a file from this app's storage by `cid`. Requires `drive:write`. */
  delete(cid: string): Promise<void>;
  /**
   * Delete every live file with this exact name. Requires `drive:write` and
   * rejects `maypop/not-found` when no matching file exists.
   */
  remove(name: string): Promise<void>;
}

// #endregion capability:drive

// #region capability:ai

/**
 * One part of a multimodal message: text, or an image for the model to look
 * at. Both tiers accept image input — when the user's question is about a
 * picture, pass the picture itself; never describe/transcribe an image into
 * text with a separate call as a workaround.
 */
type MaypopAiContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      /**
       * `url` is a base64 `data:` URL (`FileReader.readAsDataURL` on an
       * upload, `canvas.toDataURL()`), or an `https:` URL — a drive file via
       * `await maypop.drive.url(cid)` (NOT `imageUrl()`, which is page-local)
       * is inlined and resized server-side before it reaches the provider.
       */
      image_url: { url: string };
    };

/** One message in a chat conversation (OpenAI-compatible). */
interface MaypopAiMessage {
  /** Who authored the message. */
  role: "system" | "user" | "assistant" | "tool";
  /** The message text — or, to show the model images (vision input), an
   *  array mixing text and image parts. */
  content: string | MaypopAiContentPart[];
}

/**
 * Which model tier to run a request on. You name a *tier*, not a specific
 * model — the platform maps each tier to a concrete model and may re-point it
 * over time, so choose by the shape of the task, not a model you have in mind.
 */
type MaypopAiModel =
  /**
   * Small, fast, and inexpensive. Best for simple, high-volume, or
   * latency-sensitive calls where a smaller model will plainly do: short
   * rewrites, extracting a field, generating a name or title, quick
   * suggestions. Reach for this first when the task is well-scoped. (For
   * classifying or routing input, {@link MaypopAi.decide} is cheaper and
   * needs no parsing.)
   *
   * e.g. an RPG app uses `"fast"` to suggest character names or a quest title.
   */
  | "fast"
  /**
   * Larger and more capable, at higher latency and cost. Use when the task
   * needs genuine reasoning, creativity, or long, coherent output — where
   * quality clearly matters more than speed.
   *
   * e.g. an RPG app uses `"smart"` for the game master that narrates scenes and
   * runs the world.
   */
  | "smart";

/**
 * An OpenAI-compatible chat-completions request body. Forwarded almost
 * verbatim, so any common field (`temperature`, `tools`, `response_format`, …)
 * passes through. `stream` is managed for you: omit it for {@link MaypopAi.chat},
 * it is forced on for {@link MaypopAi.stream}.
 */
interface MaypopAiRequest {
  /**
   * Which model tier to run on — `"fast"` or `"smart"`. Required. See
   * {@link MaypopAiModel} for how to choose. You can't request a raw provider
   * model; the tier is resolved to one server-side.
   */
  model: MaypopAiModel;
  /** The conversation so far. The API is stateless — send the full history. */
  messages: MaypopAiMessage[];
  /** Any other provider-supported field (temperature, max_tokens, tools, …). */
  [key: string]: unknown;
}

/**
 * An image generation request. `prompt` is required; other provider-supported
 * fields pass through. Add `image` to transform existing images instead of
 * generating from scratch. There is NO `model` field — the platform pins the
 * image model server-side (one is ignored if sent).
 */
type MaypopAiImageRequest = MaypopAiFastImageRequest | MaypopAiQualityImageRequest;

/** Fast is the default and supports higher resolutions and batches. */
interface MaypopAiFastImageRequest extends MaypopAiImageOptions {
  tier?: "fast";
  /** Output resolution; defaults to 2K. */
  size?: "2K" | "3K" | "4K" | MaypopAiImagePixelSize;
}

/** Quality uses Pro: a single output at 2K, with no 3K/4K presets or batches. */
interface MaypopAiQualityImageRequest extends MaypopAiImageOptions {
  tier: "quality";
  /** Defaults to 2K. Custom pixel dimensions must fit Pro's 2K pixel limit;
   *  the backend validates their numeric bounds at runtime. */
  size?: "2K" | MaypopAiImagePixelSize;
  n?: 1;
  sequential_image_generation?: "disabled";
  sequential_image_generation_options?: { max_images: 1 };
}

/**
 * Output size. Either a resolution PRESET — `"2K"`, `"3K"`, or `"4K"` — or
 * an explicit `"WIDTHxHEIGHT"` pixel string, e.g. `"2048x2048"` or
 * `"2560x1440"`. Omit for `"2K"`.
 * Request at least 2K, using a preset or the recommended pixel dimensions below.
 * Quality rejects 3K/4K and batches; use Fast for those requests.
 *
 * There is NO aspect-ratio form: `"16:9"`, `"1:1"`, `"auto"`, etc. are NOT
 * valid `size` values and are rejected by the gateway (a common failure),
 * and there is no separate `aspect_ratio` field. A preset always yields a
 * SQUARE image — for any other shape pass explicit pixels. Recommended
 * 2K-tier sizes per ratio (swap width/height for the portrait variant):
 *   1:1  → "2048x2048"
 *   4:3  → "2304x1728"   (3:4  → "1728x2304")
 *   3:2  → "2496x1664"   (2:3  → "1664x2496")
 *   16:9 → "2560x1440"   (9:16 → "1440x2560")
 *   21:9 → "3024x1296"
 * These 2K sizes are the right default; reach for 4K only for final,
 * zoomable assets (4K 1:1 is "4096x4096"). Pixels must stay within the
 * provider's range after normalization: total pixels in `[2560x1440,
 * 4096x4096]` for Fast (Quality caps at 4,624,220 pixels) and aspect
 * ratio within `[1/16, 16]`.
 */
type MaypopAiImagePixelSize = `${number}x${number}`;

/** Shared image inputs and provider options; output limits depend on the tier. */
interface MaypopAiImageOptions {
  /** What to draw. Required — even with `image` input, where it describes the
   *  EDIT ("make it watercolor", "add a night sky"), not the whole scene. */
  prompt: string;
  /**
   * Optional input image(s) — the model supports image-to-image: editing,
   * style transfer, or combining references ("this character in this scene").
   * A single image or an array of up to 10. Each entry is either a publicly
   * fetchable `https:` URL or a base64 data URL
   * (`data:image/png;base64,...` — jpeg/png/webp also fine).
   *
   * Getting a usable value:
   * - user upload / canvas: a data URL via `FileReader.readAsDataURL(file)`
   *   or `canvas.toDataURL("image/png")`;
   * - a drive file: `await maypop.drive.url(cid)` — the short-lived signed
   *   URL is fetchable by the provider if used immediately. `imageUrl()`
   *   does NOT work here: it returns a local/blob URL only this page can
   *   resolve;
   * - a just-generated image: the short-lived `url` from a previous
   *   `ai.image` call.
   */
  image?: string | string[];
  /**
   * `"url"` (default) returns short-lived hosted URLs; `"b64_json"` returns
   * the image bytes inline as base64.
   */
  response_format?: "url" | "b64_json";
  /** Any other provider-supported field (`seed`, `watermark`, …). */
  [key: string]: unknown;
}

/**
 * One generated image: a short-lived `url` OR inline `b64_json`, depending on
 * the request's `response_format`.
 */
interface MaypopAiImage {
  url?: string;
  b64_json?: string;
}

/** Video generation with server-selected Seedance models. */
interface MaypopAiVideoRequest {
  /** Describe the scene, action, camera motion and sound in up to 5000 characters. */
  prompt: string;
  /** Fast is the default; quality supports longer clips and costs more credits. */
  model?: "fast" | "quality";
  /** Integer seconds: 4–15 for fast, 4–30 for quality; defaults to 5. */
  duration?: number;
  resolution?: "480p" | "720p";
  ratio?: "16:9" | "9:16" | "4:3" | "3:4" | "1:1" | "21:9";
  /** Up to nine reference images as HTTPS or image data URLs. */
  images?: string[];
  /** Include synchronized audio; defaults to false. */
  generate_audio?: boolean;
  seed?: number;
}

/** Durable MP4 bytes, independent of expiring provider URLs. */
interface MaypopAiVideoResult {
  /** Raw base64; play with `data:video/mp4;base64,${result.video}`. */
  video: string;
  mime_type: "video/mp4";
  duration: number;
}

/** A reference voice/clip or image. Audio and image references cannot be mixed. */
type MaypopAiAudioReference =
  | { speaker: string; audio_url?: never; audio_data?: never; image_url?: never; image_data?: never }
  | { audio_url: string; speaker?: never; audio_data?: never; image_url?: never; image_data?: never }
  | { audio_data: string; speaker?: never; audio_url?: never; image_url?: never; image_data?: never }
  | { image_url: string; image_data?: never; speaker?: never; audio_url?: never; audio_data?: never }
  | { image_data: string; image_url?: never; speaker?: never; audio_url?: never; audio_data?: never };

/** Generate music, speech, voices, sound effects, or ambience with BytePlus. */
interface MaypopAiAudioRequest {
  /** Natural-language scene, timbre, effects, or speech; at most 3000 characters.
   * Use @Audio1 through @Audio3 for reference clips. With an image reference,
   * supply only the text to speak. Output is limited to 120 seconds. */
  prompt: string;
  /** Up to three audio references (30s/10MB each), OR one image (10MB).
   * Use public URLs or raw base64 bytes. No model/key is needed. */
  references?: MaypopAiAudioReference[];
  audio_config?: {
    format?: "wav" | "mp3" | "pcm" | "ogg_opus";
    sample_rate?: number;
    speech_rate?: number;
    loudness_rate?: number;
    pitch_rate?: number;
    enable_subtitle?: boolean;
  };
  watermark?: Record<string, unknown>;
}

/** Buffered audio bytes plus the provider's timing and optional subtitles. */
interface MaypopAiAudioResult {
  /** Raw base64 audio. MIME type follows the requested format (default WAV). */
  audio: string;
  /** Temporary download URL; expires after two hours. */
  url?: string;
  duration?: number;
  original_duration?: number;
  [key: string]: unknown;
}

/**
 * A speech-to-text request. There is NO `model` field — the platform pins the
 * transcription model server-side (one is ignored if sent).
 */
interface MaypopAiTranscriptionRequest {
  /**
   * The audio to transcribe. Pass a `Blob`/`File` (e.g. a `MediaRecorder`
   * recording) — it's base64-encoded for you — or a pre-encoded base64 string
   * of the raw bytes (no `data:` URI prefix).
   */
  audio: Blob | string;
  /**
   * Audio container/codec, e.g. `"webm"`, `"mp3"`, `"wav"`, `"m4a"`, `"ogg"`.
   * Inferred from a `Blob`'s MIME type when omitted; required for a base64
   * string.
   */
  format?: string;
  /** Optional ISO-639-1 hint (e.g. `"en"`) — improves accuracy and latency. */
  language?: string;
  /** Any other provider-supported field. */
  [key: string]: unknown;
}

/**
 * What a decision is made about: everything the decision model may look at.
 * Plain text, or a JSON object/array — pass structured state as-is (the user's
 * message plus the current screen, a draft the model wrote, the arguments of a
 * tool call) rather than flattening it into prose. Up to ~32k tokens.
 */
type MaypopAiDecisionState = string | Record<string, unknown> | unknown[];

/** A question's wording, or one criterion: prose, or structured JSON. */
type MaypopAiDecisionInstructions = string | Record<string, unknown> | unknown[];

/**
 * One closed question for {@link MaypopAi.decide}. Every question is answered
 * independently over the same `state`; its key in the request's `questions`
 * map is the key its answer comes back under. The `criteria` wording matters
 * more than the `instructions`: describe each side or option as the model
 * should recognise it IN THE STATE ("an explicit request to remove, wipe, or
 * reset data"), not as a label.
 */
type MaypopAiDecisionQuestion =
  /**
   * A yes/no question, answered as the probability of "true" (upstream calls
   * this a "noul"). `criteria.true` / `criteria.false` describe each side.
   */
  | {
      type: "noul";
      instructions: MaypopAiDecisionInstructions;
      criteria: {
        true: MaypopAiDecisionInstructions;
        false: MaypopAiDecisionInstructions;
      };
    }
  /**
   * Pick one of a fixed set of options. `criteria` maps each option key to
   * what it covers; the answer names the winning key and gives a probability
   * per option. Include a catch-all option ("other", "chat") so the model has
   * somewhere to put input that fits none of the real ones.
   */
  | {
      type: "choice";
      instructions: MaypopAiDecisionInstructions;
      criteria: Record<string, MaypopAiDecisionInstructions>;
    }
  /**
   * Rate the state on an ordered scale. `criteria` lists the levels from
   * lowest (index 0) to highest; the answer is a probability-weighted position
   * on that index scale, plus a probability per level.
   */
  | {
      type: "score";
      instructions: MaypopAiDecisionInstructions;
      criteria: string[];
    };

/**
 * A decisions request — the OpenRouter decisions body, forwarded verbatim.
 * There is NO `model` field: the platform pins the decision model server-side
 * (one is ignored if sent). The response arrives as
 * {@link MaypopAiDecisionResponse}.
 */
interface MaypopAiDecisionRequest {
  /** What to decide about. See {@link MaypopAiDecisionState}. */
  state: MaypopAiDecisionState;
  /**
   * Named questions, answered independently. Name the keys for what they
   * decide (`route`, `destructive`, `urgency`) — they come back as
   * `answers[name]`. At least one is required.
   */
  questions: Record<string, MaypopAiDecisionQuestion>;
  /**
   * Optional id grouping related calls (one conversation, one editing
   * session) for provider-side continuity. Scoped to the current user
   * server-side, so two viewers can never share one.
   */
  session_id?: string;
  /** Any other decision-model field. */
  [key: string]: unknown;
}

/**
 * The answer to one {@link MaypopAiDecisionQuestion}, under the same key.
 * Discriminate on `type`. Every probability is 0..1.
 */
type MaypopAiDecisionAnswer =
  /** `noul` is the probability the answer is "true". 0.96 means almost
   *  certainly yes; values near 0.5 mean the state doesn't say. */
  | { type: "noul"; noul: number }
  /**
   * `choice` is the winning option key. `probabilities` compares every option
   * (use it for a runner-up, or to show "did you mean…" when the top two are
   * close); `confidence` summarises how concentrated that distribution is.
   */
  | {
      type: "choice";
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  /**
   * `score` is the probability-weighted position on the level index scale —
   * e.g. `1.99` on a three-level scale means "almost certainly the top
   * level". `probabilities` and `legend` are keyed by level index as strings
   * (`"0"`, `"1"`, …); `legend` echoes the level descriptions.
   */
  | {
      type: "score";
      score: number;
      confidence?: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, string>;
    };

/** What {@link MaypopAi.decide} resolves with. */
interface MaypopAiDecisionResponse {
  id: string;
  /** The decision model that answered — informational only, and may change. */
  model: string;
  provider?: string;
  /** One answer per question, under the question's key. */
  answers: Record<string, MaypopAiDecisionAnswer>;
  /** Token counts and the provider's cost in USD, for your own accounting. */
  usage: { input_tokens: number; output_tokens: number; cost: number };
  [key: string]: unknown;
}

/**
 * The app's gateway to the AI models. Calls run through the Maypop backend
 * using server-side provider keys (never exposed to the app) and are gated by
 * the `ai:use` scope — so a template (e.g. an AI game master) can let a model
 * drive gameplay, narrate, answer, illustrate, or generate music, audio, voices,
 * sound effects and ambience, without ever holding a key.
 *
 * Usage is metered and billable, so `ai:use` is granted to members but never
 * to anonymous share-link guests; gate AI UI on `maypop.permissions`.
 *
 * WEB SEARCH / LIVE DATA: the models can browse the live web. When a prompt
 * needs current or real-time information — today's news, prices, scores, recent
 * events, anything past the model's training cutoff — the platform runs a web
 * search server-side and feeds the results to the model automatically; you do
 * not enable anything. So to fetch live data, just ASK the model for it through
 * {@link MaypopAi.chat}/{@link MaypopAi.stream} — do NOT call a third-party HTTP
 * API (NewsAPI, weather APIs, etc.) from app code. Those almost always fail in
 * the sandboxed iframe (browser CORS, or a leaked/blocked API key — e.g. a 426
 * "upgrade required"), whereas `maypop.ai` needs no key and no network access of
 * your own. When the model searches, its cited sources come back on
 * `res.choices[0].message.annotations` as `{ type: "url_citation", url, title }`
 * entries — render them as source links. To show a PICTURE for a result, pass
 * its citation/source `url` to {@link MaypopLink.unfurl} and use the returned
 * `image` (the page's og:image) — web search returns URLs, not images, so
 * unfurling is how you get a real picture for a card.
 *
 * PARSING STRUCTURED REPLIES: ask for structured output (e.g. "reply with ONLY
 * a JSON array of {title, url, summary}"), but NEVER call `JSON.parse` on the
 * raw reply — a web-search reply routinely wraps the JSON in a ```json fence or
 * trails it with a "Sources:" note, which makes a naive parse throw. Extract the
 * first balanced JSON value first, ignoring anything around it:
 *
 * ```js
 * function extractJson(text) {
 *   let t = text.trim().replace(/^```(?:json)?\s{0,}/i, "").replace(/```\s*$/, "");
 *   const start = t.search(/[[{]/);
 *   if (start === -1) throw new Error("No JSON in reply");
 *   const stack = [];
 *   let inStr = false, esc = false;
 *   for (let i = start; i < t.length; i++) {
 *     const c = t[i];
 *     if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
 *     if (c === '"') inStr = true;
 *     else if (c === "{" || c === "[") stack.push(c);
 *     else if ((c === "}" || c === "]") && (stack.pop(), stack.length === 0)) return JSON.parse(t.slice(start, i + 1));
 *   }
 *   throw new Error("Incomplete JSON in reply");
 * }
 * const data = extractJson(res.choices[0].message.content);
 * ```
 *
 * Methods throw `maypop/forbidden` when `ai:use` isn't granted — the case a
 * viewer without an account lands in.
 *
 * A viewer with no account has no `ai:use` (AI rides with the account, like
 * writing does). So on an app whose link grants `use`, running one of these
 * throws `maypop/sign-in-required` instead and asks the host for its sign-in
 * card — see {@link Maypop.signInRequired}, and prefer showing "Sign in to
 * ask" over a chat box that refuses. `models()` never raises that card: asking
 * what you could run is not running it.
 *
 * Every method here can also throw `maypop/ai-limit` when the user has
 * exhausted their daily AI allowance (the free plan includes a fixed number
 * of AI credits per day, resetting at midnight UTC) or their plan doesn't
 * cover the call.
 * Catch it and show a friendly "Daily AI limit reached — try again tomorrow
 * or upgrade your plan." state — never auto-retry, the limit won't reset for
 * hours.
 */
interface MaypopAi {
  /**
   * The model tiers this app may call, each with guidance on when to use it:
   * `{ data: [{ id: "fast", description }, { id: "smart", description }] }`. A
   * fixed, named set (see {@link MaypopAiModel}) — handy for a tier picker.
   */
  models(): Promise<{ data: Array<{ id: MaypopAiModel; description: string }> }>;
  /**
   * Stream a chat completion. `onDelta` is called with each text fragment as it
   * arrives (and the raw OpenAI-shaped stream event); the promise resolves with
   * the full concatenated text once the stream ends.
   *
   * PREFER THIS over {@link MaypopAi.chat} for any user-visible generation —
   * narration, chat replies, summaries, long-form text. Rendering tokens as
   * they arrive reads as instant even for a long reply; `chat` leaves the UI
   * frozen on a spinner until the whole answer is back.
   *
   * ```js
   * await maypop.ai.stream(
   *   { model: "smart", messages },  // the game master — pick the capable tier
   *   (chunk) => { output.textContent += chunk; },
   * );
   * ```
   */
  stream(
    request: MaypopAiRequest,
    onDelta: (text: string, event: Record<string, unknown>) => void,
  ): Promise<string>;
  /**
   * Run a chat completion and resolve with the full OpenAI-shaped response
   * (`{ id, choices: [{ message: { content } }], usage, ... }`).
   *
   * Reach for this only when you need the complete reply before you can do
   * anything with it — structured JSON to drive app logic, or a short
   * classification/field extraction with nothing to progressively render.
   * For anything the user watches come in, use {@link MaypopAi.stream} instead.
   *
   * ```js
   * const res = await maypop.ai.chat({
   *   model: "fast",
   *   messages: [{ role: "user", content: "Suggest a tavern name." }],
   * });
   * console.log(res.choices[0].message.content);
   * ```
   *
   * VISION: to ask about an image, put it in the message itself (see
   * {@link MaypopAiContentPart}) — don't describe the image in prose:
   *
   * ```js
   * const res = await maypop.ai.chat({
   *   model: "smart",
   *   messages: [{
   *     role: "user",
   *     content: [
   *       { type: "text", text: "What plant is this? One short sentence." },
   *       { type: "image_url", image_url: { url: await maypop.drive.url(cid) } },
   *     ],
   *   }],
   * });
   * ```
   *
   * STRUCTURED OUTPUT: if the JSON you want is only a label, a yes/no, or a
   * score, don't ask a chat model for it at all — {@link MaypopAi.decide}
   * returns exactly that, typed, with nothing to parse. When you do need
   * richer JSON to drive app logic, ask for it in the prompt but never trust
   * the reply to be clean — models often
   * wrap JSON in a ` ```json ` code fence even when told not to, so a bare
   * `JSON.parse(content)` throws at runtime. Strip fences and trim first, and
   * wrap the parse in try/catch so a malformed reply degrades gracefully (retry
   * once or show an error) instead of crashing the app.
   *
   * ```js
   * const content = res.choices[0].message.content;
   * let data;
   * try {
   *   const unfenced = content.trim()
   *     .replace(/^```(?:json)?/i, "")  // drop a leading ```json fence
   *     .replace(/```$/, "")            // drop the closing fence
   *     .trim();
   *   data = JSON.parse(unfenced);
   * } catch {
   *   // retry once, or surface a friendly "couldn't read the AI reply" state
   * }
   * ```
   */
  chat(request: MaypopAiRequest): Promise<Record<string, unknown>>;
  /**
   * Ask the decision model one or more CLOSED questions about a piece of
   * state and resolve with calibrated probabilities — never free text. See
   * {@link MaypopAiDecisionQuestion} for the three question types (yes/no,
   * pick-one, rate-on-a-scale) and {@link MaypopAiDecisionAnswer} for what
   * comes back.
   *
   * PREFER THIS over `chat({ model: "fast" })` whenever the answer is one of a
   * fixed set: classifying input, routing a message to a screen, gating a
   * destructive action, checking or ranking something a chat model wrote. It
   * answers in well under a second, costs a small fraction of a chat call,
   * and returns typed numbers, so there is nothing to parse and nothing to
   * go wrong parsing. It replaces the fence-stripping STRUCTURED OUTPUT
   * pattern on {@link MaypopAi.chat} wherever the JSON you wanted was only a
   * label, a boolean, or a score.
   *
   * It CANNOT write anything — no explanations, no text. Pair the two: decide
   * first (which screen? is this safe?), then generate with
   * {@link MaypopAi.stream}.
   *
   * ```js
   * const { answers } = await maypop.ai.decide({
   *   state: { message: input.value, screen: currentScreen },
   *   questions: {
   *     route: {
   *       type: "choice",
   *       instructions: "Which screen should handle this message?",
   *       criteria: {
   *         inventory: "asks about items, gear, or stock",
   *         quests: "asks about quests, goals, or objectives",
   *         chat: "anything else — small talk, questions for the narrator",
   *       },
   *     },
   *     destructive: {
   *       type: "noul",
   *       instructions: "Does the user want to delete or reset data?",
   *       criteria: {
   *         true: "an explicit request to remove, wipe, or start over",
   *         false: "no removal intent",
   *       },
   *     },
   *   },
   * });
   * // Cheap to ask, costly to get wrong -> act on a LOW probability.
   * if (answers.destructive.noul > 0.35) return confirmDelete();
   * navigate(answers.route.choice);
   * ```
   *
   * THRESHOLDS: tune each cutoff to the cost of that mistake, not to 0.5.
   * Gating something irreversible, act on a low probability (0.2–0.4).
   * Auto-applying a label the user can undo with one tap, wait for a high one
   * (0.8+). When a `choice` answer's top two `probabilities` are close, show
   * both instead of picking silently.
   *
   * Cheap enough to call on every interaction — it needs no explicit
   * "Generate" gesture, unlike {@link MaypopAi.image}. It is still metered and
   * gated like every AI call: `maypop/ai-limit`, `maypop/sign-in-required`,
   * and `maypop/forbidden` behave exactly as for {@link MaypopAi.chat}.
   *
   * There is NO `model` field — the platform pins the decision model
   * server-side. Preview: the model behind this is in beta upstream; the
   * fields above are stable, new optional ones may appear.
   */
  decide(request: MaypopAiDecisionRequest): Promise<MaypopAiDecisionResponse>;
  /**
   * Generate images from a text prompt — or edit / restyle existing ones by
   * also passing `image` (see {@link MaypopAiImageRequest}). Resolves with
   * the provider-shaped response: `{ data: [{ url | b64_json }], usage, ... }`.
   *
   * Image generation is metered and notably more expensive than a chat call —
   * trigger it from an explicit user action (a "Generate" button), never
   * automatically or per-turn. Returned `url`s are short-lived: anything worth
   * keeping should be fetched and saved with `maypop.drive.upload`.
   *
   * Throws `maypop/ai-blocked` when the provider's content moderation rejects
   * the prompt or the GENERATED image. The output scan is probabilistic — an
   * innocuous prompt can occasionally trip it (photorealistic people are the
   * usual false positive) — so treat it as retryable, not fatal: show the
   * user a friendly "blocked by content filter — try again or rephrase"
   * state with a retry button (a retry costs another generation, so don't
   * auto-loop). Stylized art directions (watercolor, cartoon, pixel art)
   * trip the filter far less than photorealism.
   *
   * ```js
   * try {
   *   const res = await maypop.ai.image({ prompt: "a watercolor fox" });
   *   img.src = res.data[0].url;
   * } catch (e) {
   *   if (e.code === "maypop/ai-blocked") showRetryUi(e.message);
   *   else if (e.code === "maypop/ai-limit") showLimitUi(e.message); // out of daily AI credits — no retry button
   *   else throw e;
   * }
   *
   * // Image-to-image — restyle a photo the user saved to drive:
   * const edit = await maypop.ai.image({
   *   prompt: "turn this photo into a watercolor painting",
   *   image: await maypop.drive.url(file.cid), // NOT imageUrl() — local-only
   * });
   * ```
   */
  image(
    request: MaypopAiImageRequest,
  ): Promise<{ data: MaypopAiImage[]; [key: string]: unknown }>;
  /**
   * Generate music, voices, audiobook narration, voiceovers, game sound effects,
   * or ambience from natural language, optionally guided by audio or an image.
   * Non-streaming; up to 120 seconds. The platform selects the model.
   * Trigger from an explicit user action, show pending/error states, and never
   * auto-retry paid generations. Requires ai:use, including in Studio preview.
   * Save the bytes to drive and store the CID in KV to keep the result.
   *
   * ```js
   * const result = await maypop.ai.audio({
   *   prompt: "A calm voice welcomes the player over gentle ambient music.",
   *   audio_config: { format: "mp3" },
   * });
   * player.src = `data:audio/mpeg;base64,${result.audio}`;
   * // Let the user press Play; browsers may block autoplay after generation.
   * ```
   */
  audio(request: MaypopAiAudioRequest): Promise<MaypopAiAudioResult>;

  /** Generate video on an explicit user action. May take several minutes.
   * Show progress and errors; never automatically retry paid generations.
   * Save returned bytes to drive and the CID to kv for durable user creations.
   */
  video(request: MaypopAiVideoRequest): Promise<MaypopAiVideoResult>;

  /**
   * Transcribe speech to text. Resolves with `{ text, ... }` — the verbatim
   * transcript plus the provider's usage envelope.
   *
   * Record audio in the browser and hand the resulting `Blob` straight in:
   *
   * ```js
   * const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
   * const rec = new MediaRecorder(stream);
   * const chunks = [];
   * rec.ondataavailable = (e) => chunks.push(e.data);
   * rec.onstop = async () => {
   *   const audio = new Blob(chunks, { type: rec.mimeType });
   *   const { text } = await maypop.ai.transcribe({ audio });
   *   input.value = text;
   * };
   * rec.start();
   * // …later: rec.stop();
   * ```
   */
  transcribe(
    request: MaypopAiTranscriptionRequest,
  ): Promise<{ text: string; [key: string]: unknown }>;
}

// #endregion capability:ai

// #region capability:members

/**
 * Someone who can reach this app, as the app is allowed to see them — same
 * PSEUDONYMOUS identity rules as {@link MaypopUser}. Their `id` matches what
 * `maypop.user.id` returns for that person in THIS app, so you can correlate
 * people with KV entry authors; it is never their real Maypop id and differs
 * across apps.
 */
interface MaypopMember {
  /** Pseudonymous, app-scoped id. Matches `maypop.user.id` for that person. */
  id: string;
  /** Display name. */
  username: string;
  /**
   * What they may do with the app: `"admin"` (the app's author, or a group
   * given admin over it), `"editor"`, `"writer"`, or `"reader"`. Treat it as a
   * hint for labels and optional UI, never as your own permission check — the
   * server decides what a caller may actually do.
   */
  role: string;
  /** Avatar URL, or null if none. */
  avatarUrl: string | null;
  /**
   * Whether they have a live session for this app right now (their token
   * refreshed within the last few minutes). Use it for presence/online
   * indicators; it is a recent-activity heuristic, not a realtime socket.
   */
  connected: boolean;
}

/** The result of {@link Maypop.members}. */
interface MaypopMemberList {
  /**
   * Everyone who can reach this app, including the current viewer. Ordered by
   * username, so rendering it directly is stable across calls.
   */
  members: MaypopMember[];
  /**
   * Count of *other* live anonymous share-link viewers. They have no account,
   * so they never appear in `members` — render them as "+3 viewing" rather
   * than as people. A signed-out viewer sees themselves in `members` as
   * `role: "reader"` and is not counted here.
   */
  guestCount: number;
}

// #endregion capability:members

// #region capability:apps

/**
 * Switch the viewer to another app.
 *
 * This does not enumerate anything: there is no roster of "apps near you", and
 * nothing here tells you which apps exist. You supply an app id you already
 * know — one you shipped with, one a person pasted in, or one taken from a
 * public app's share URL — and the host decides whether it can honour it.
 *
 * Opening is a HOST action: it navigates the page around your iframe, so it
 * only works where the host renders a surface it can switch within. Trigger it
 * from an explicit user action; the host is free to refuse anything else.
 */
interface MaypopApps {
  /**
   * Ask the host to switch to the app with this id. Resolves once the host has
   * accepted; rejects with `maypop/app-not-found` when it can't reach that app
   * from here, or `maypop/unsupported` when it can't switch apps at all (a
   * share-link page, for instance, shows one app and nothing else). Always
   * catch and degrade — treat a working switch as a bonus, never a given.
   *
   * ```js
   * try {
   *   await maypop.apps.open(pastedAppId);
   * } catch {
   *   showLinkInstead(pastedAppId);
   * }
   * ```
   */
  open(id: string): Promise<void>;
}

// #endregion capability:apps

// #region capability:multiplayer

/**
 * One person currently in a multiplayer room, as seen via {@link MaypopRoom.peers}.
 */
interface MaypopRoomPeer {
  /**
   * Pseudonymous, app-scoped viewer id — matches `maypop.user.id` for that
   * person and the `author` of their kv writes.
   */
  id: string;
  /**
   * Display name from the app's roster, or null when it can't be resolved
   * (anonymous share-link guests, or no `group:read` scope).
   */
  username: string | null;
  /** Avatar URL from the roster, or null. */
  avatarUrl: string | null;
  /** This peer's own state — the last value they passed to `setMyState`, or null. */
  state: unknown;
  /**
   * ISO-8601 time of their last presence heartbeat (server clock). On the
   * current viewer's own row this is simply the time of the read.
   */
  updatedAt: string;
  /** True on the current viewer's own row. */
  self: boolean;
}

/**
 * A live multiplayer room, returned by {@link MaypopMultiplayer.join}.
 *
 * Two kinds of state, with different conflict rules:
 * - **Shared state** (`state` / `setState`) — ONE value for the whole room,
 *   replaced wholesale, last-write-wins. Concurrent writers clobber each
 *   other, so keep one natural writer at a time (e.g. whoever's turn it is),
 *   or store per-person data in per-peer state instead.
 * - **Per-peer state** (`setMyState`, read from `peers[i].state`) — each peer
 *   owns their own value, so there are NO write conflicts. Ideal for ready
 *   flags, selections, answers, hands, scores, coarse cursors.
 *
 * Both apply locally at once and sync peer-to-peer: a DISCRETE state change
 * (a move, a vote, a claim) reaches live peers in well under a second.
 * Rapid writes are coalesced (the latest value wins, intermediate values
 * may be skipped), and sustained rewriting of the same key delivers to
 * peers at a much lower rate than it is written — rooms are for state that
 * changes at human cadence, NOT for continuous streams. A cursor position,
 * drag, slider, or anything updated many times per second belongs on
 * {@link MaypopMultiplayer.connect} instead. Values must be
 * JSON-serializable and small — this is shared session state, not a data
 * store.
 */
interface MaypopRoom {
  /** The room id passed to `join`. */
  readonly id: string;
  /** The current viewer's peer id (=== `maypop.user.id`). */
  readonly me: string;
  /**
   * Everyone currently present (heartbeat within the presence timeout),
   * including the current viewer, sorted by id. Read-only spectators are
   * never listed.
   */
  readonly peers: MaypopRoomPeer[];
  /** The room's shared state, or null until someone calls `setState`. */
  readonly state: unknown;
  /**
   * Replace the room's shared state. Applies locally at once; throws
   * `maypop/read-only` for a read-only viewer and `maypop/left` after
   * `leave()`.
   */
  setState(value: unknown): void;
  /** Publish the current viewer's per-peer state. Same rules as `setState`. */
  setMyState(value: unknown): void;
  /**
   * Subscribe to every room change — peers joining/leaving/timing out, shared
   * or per-peer state. Fires immediately with the current snapshot, then on
   * each change. Returns an unsubscribe function.
   *
   * ```js
   * const off = room.subscribe((r) => render(r.peers, r.state));
   * ```
   */
  subscribe(cb: (room: MaypopRoom) => void): () => void;
  /**
   * Leave the room: stop heartbeating, disappear from `peers`, and drop
   * this browser's replica of the state. When the last participant leaves,
   * the room's state is gone everywhere. Call this when the session UI
   * closes; a closed tab that never gets to call it is covered by the
   * presence timeout instead.
   */
  leave(): Promise<void>;
}

/**
 * Ephemeral multiplayer rooms — live session state that exists only in the
 * participants' browsers. A room syncs peer-to-peer (end-to-end encrypted;
 * the backend only introduces peers), so writes reach everyone at p2p
 * latency — tens of milliseconds — and a late joiner pulls the current
 * state from whoever is already there.
 *
 * Good for: presence ("who's here"), lobbies, games (turn-based and
 * fast-moving), polls and votes, shared boards. For raw per-frame packet
 * streams (action-game inputs, live cursors), use `connect()` instead —
 * rooms sync STATE, sessions stream MESSAGES.
 *
 * FIRST CHECK whether the feature needs a room at all: `maypop.kv` is
 * already live-synced — every member's `kv.subscribe` callbacks fire when
 * anyone writes, and the data persists. A shared list, board, scoreboard,
 * or settings that "updates for everyone" is plain `kv`, not multiplayer.
 * Reach for a room only for what kv alone can't express: who is present
 * RIGHT NOW, per-player session state, and session lifecycle.
 *
 * Lifecycle: presence is heartbeat-based — a peer that closes the tab or
 * crashes drops out of `peers` after `presenceTimeoutMs` (default and
 * maximum 45s). Rooms are EPHEMERAL in the strongest sense: state lives
 * only in the open tabs of the people in the room, and when the last one
 * leaves the party is over — the state is gone everywhere. Anything worth
 * keeping after the session must also be written to plain `maypop.kv`.
 *
 * Read-only viewers join as spectators: they see `state` and `peers` but
 * don't appear in `peers`, and their `setState`/`setMyState` throws
 * `maypop/read-only`.
 *
 * In the studio the room is real like everything else — you are simply the
 * only person in it until someone else opens the app. The p2p engine (~1MB
 * compressed wasm) loads lazily on the first join.
 *
 * Design for solo play: keep game SEATS in the shared state and let peers
 * claim them, rather than equating `peers` with the player list. One person
 * can then claim several seats to test alone (there is exactly one peer while
 * they are the only person in the app), an empty seat can be filled by a bot, and the game survives a
 * peer disconnecting. Bots should be scripted logic by default; an AI
 * opponent (`maypop.ai`) spends the user's metered AI allowance, so only add
 * one when gameplay truly needs language/creativity, behind an explicit
 * user action — never as an automatic per-turn call.
 */
interface MaypopMultiplayer {
  /**
   * Join (or implicitly create) a room. With no `roomId` everyone in the
   * group lands in the same single default session ("main") — the right
   * shape for most apps, no lobby or room-code UI needed. Pass explicit ids
   * (`[A-Za-z0-9_.-]+`) only when the app needs parallel sessions, e.g.
   * several matches running at once.
   *
   * ```js
   * await maypop.ready();
   * const room = await maypop.multiplayer.join();
   * room.subscribe((r) => render(r.peers, r.state));
   * room.setMyState({ ready: true });
   * ```
   */
  join(
    roomId?: string,
    opts?: {
      /**
       * Silent peers drop out of `peers` after this. Default 45_000, which
       * is also the maximum (the rendezvous prunes announces at 45s).
       */
      presenceTimeoutMs?: number;
    },
  ): Promise<MaypopRoom>;
  /**
   * Open a peer-to-peer session (iroh transport). Unlike `join` — whose
   * state syncs through the backend — packets here travel DIRECTLY between
   * peers over an end-to-end-encrypted QUIC connection; the backend is only
   * the rendezvous where peers find each other. Reach for this for what
   * rooms can't do: high-rate, low-latency packets (action games, live
   * cursors, streams of ephemeral events).
   *
   * There is no shared state and nothing persists: messages reach the peers
   * connected at that moment, and a peer that reloads reappears with a NEW
   * `endpointId`. Keep durable data in `maypop.kv`; pair with `join()` when
   * the app also wants synced session state.
   *
   * The transport (~2.5MB of wasm) loads lazily on the first call. Peers
   * discover each other within ~10s of connecting.
   *
   * ```js
   * await maypop.ready();
   * const session = await maypop.multiplayer.connect();
   * session.subscribe((s) => renderPeers(s.peers));
   * session.onMessage(({ from, payload }) => apply(payload));
   * session.broadcast({ kind: "cursor", x, y });
   * ```
   */
  connect(roomId?: string): Promise<MaypopP2pSession>;
}

/**
 * One peer in a p2p session, as seen via {@link MaypopP2pSession.peers}.
 */
interface MaypopP2pPeer {
  /**
   * Pseudonymous, app-scoped viewer id — matches `maypop.user.id` for that
   * person. Null for a connected peer whose rendezvous listing has lapsed.
   * NOT unique across tabs: the same person in two tabs is two peers with
   * the same `id` and different `endpointId`s.
   */
  id: string | null;
  /** Transport address — the identity messages come `from` and `send` targets. */
  endpointId: string;
  /** Display name from the app's roster, or null when it can't be resolved. */
  username: string | null;
  /** Avatar URL from the roster, or null. */
  avatarUrl: string | null;
  /** True on the current viewer's own row. */
  self: boolean;
  /** Whether a live p2p connection to this peer is up (always true for self). */
  connected: boolean;
}

/**
 * A live p2p session, returned by {@link MaypopMultiplayer.connect}.
 *
 * Message payloads must be JSON-serializable and at most ~1MB. Messages
 * arrive whole or not at all, but are best-effort: ordering between
 * messages is not guaranteed (sequence-number payloads if it matters), and
 * they only reach peers whose `connected` is true at that moment — there is
 * no queueing for absent peers and no history for late joiners.
 */
interface MaypopP2pSession {
  /** The room id passed to `connect`. */
  readonly id: string;
  /** The current viewer's own `endpointId`. */
  readonly me: string;
  /**
   * Everyone announced in the room right now (including the current viewer),
   * sorted by `endpointId`. Presence lags reality by up to ~10s in each
   * direction (rendezvous poll / announce TTL); `connected` flips as actual
   * p2p connections come and go.
   */
  readonly peers: MaypopP2pPeer[];
  /**
   * Send one message to one peer. Throws `maypop/not-connected` when no live
   * connection to that `endpointId` exists.
   */
  send(endpointId: string, payload: unknown): Promise<void>;
  /**
   * Send one message to every connected peer; resolves to how many peers it
   * was written to (best-effort — not confirmation they received it).
   */
  broadcast(payload: unknown): Promise<number>;
  /**
   * Subscribe to incoming messages. `from` is the sender's `endpointId`.
   * Returns an unsubscribe function.
   */
  onMessage(cb: (msg: { from: string; payload: unknown }) => void): () => void;
  /**
   * Subscribe to peer-list changes (announces, connects, disconnects). Fires
   * immediately with the current snapshot. Returns an unsubscribe function.
   */
  subscribe(cb: (session: MaypopP2pSession) => void): () => void;
  /**
   * Withdraw from the rendezvous and close every connection. Call when the
   * session UI closes; a closed tab that never gets to call it drops off
   * peers' lists when its announce expires (~45s).
   */
  leave(): Promise<void>;
}

// #endregion capability:multiplayer

// #region capability:agent

/**
 * A conversational agent embedded in the app — a chat the user talks to that
 * can actually *do* things by calling the tools you give it. This is the
 * uniform way to add an assistant: the runtime (the `pi` agent loop, loaded
 * lazily on first use) handles the model call, streaming, multi-turn tool
 * calling, and context management, so you don't hand-roll any of it.
 *
 * Prefer this over calling {@link MaypopAi} directly whenever the feature is a
 * back-and-forth assistant rather than a single one-shot completion.
 */
interface MaypopAgent {
  /**
   * Create an agent session. Resolves once the runtime has loaded (the first
   * call downloads it; later calls are instant). Rejects when the viewer lacks
   * `ai:use`. Streams token-by-token; tool calls work.
   */
  create(config: MaypopAgentConfig): Promise<MaypopAgentSession>;
  /**
   * Ready-made `list_files`, `read_file`, `write_file`, and `delete_file`
   * tools backed by this app's storage. `write_file` creates only and
   * never overwrites an existing path. `prefix` mounts a path-like subfolder.
   *
   * ```js
   * const session = await maypop.agent.create({
   *   systemPrompt: "Help the group organize its documents.",
   *   tools: maypop.agent.driveTools({ prefix: "notes/" }),
   * });
   * ```
   */
  driveTools(opts?: { prefix?: string }): MaypopAgentToolDef[];
  /**
   * Stored chat history for the current viewer. Reachable without loading the
   * agent runtime — list/read/delete past conversations even before the user
   * opens one. A session persists here automatically when created with a
   * `conversationId`.
   */
  conversations: MaypopAgentConversations;
}

/** Which model tier the agent runs on — resolved to a concrete model server-side. */
type MaypopAgentTier = "fast" | "smart";

/** Summary of one stored conversation, from {@link MaypopAgentConversations.list}. */
interface MaypopAgentConversationSummary {
  /** The id passed as {@link MaypopAgentConfig.conversationId}. */
  id: string;
  /** Title derived from the first user message. */
  title: string;
  /** ISO timestamp of the last saved turn, or null. */
  updatedAt: string | null;
  /** Number of visible messages in the transcript. */
  messageCount: number;
}

/** A stored conversation's transcript, from {@link MaypopAgentConversations.get}. */
interface MaypopAgentConversation {
  id: string;
  title: string;
  updatedAt: string | null;
  /** The transcript in the same shape as {@link MaypopAgentSession.getMessages}. */
  messages: MaypopAgentMessage[];
}

/**
 * Manage the current viewer's stored chat history. History is per-viewer — each
 * person sees only their own conversations.
 */
interface MaypopAgentConversations {
  /** List stored conversations, newest first. */
  list(): Promise<MaypopAgentConversationSummary[]>;
  /** Read one conversation's transcript, or null if it doesn't exist. */
  get(id: string): Promise<MaypopAgentConversation | null>;
  /** Delete a stored conversation. */
  delete(id: string): Promise<void>;
}

/** Configuration for {@link MaypopAgent.create}. */
interface MaypopAgentConfig {
  /**
   * The agent's instructions: who it is, what it helps with, its tone, and how
   * to use its tools. Written for the model. Returned text is markdown — render
   * it as such, ideally parsing while it streams.
   */
  systemPrompt: string;
  /** Tier to run on. Defaults to `"smart"`. See {@link MaypopAiModel}. */
  model?: MaypopAgentTier;
  /**
   * The tools the agent can call to read and write app state. Give it real
   * capabilities over the app's own data — e.g. a recipe app exposes
   * `create_recipe` / `edit_recipe` / `list_recipes` — so it can act, not just
   * talk. Each `execute` runs inside the app, so it can use `maypop.kv` etc.
   */
  tools?: MaypopAgentToolDef[];
  /**
   * Starter prompt chips shown to get the user going. Plain strings are used as
   * both the label and the prompt; pass `{ label, prompt }` to differ.
   */
  chips?: (string | MaypopAgentChip)[];
  /** Reasoning effort. Defaults to `"off"`. */
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /**
   * Resume and persist this conversation by id. When set, the session loads any
   * stored transcript on creation (await {@link MaypopAgentSession.ready}) and
   * saves after each turn, so it survives reloads and appears in
   * {@link MaypopAgent.conversations}. Omit for an ephemeral chat. Use a stable,
   * unique id per conversation (e.g. `crypto.randomUUID()`).
   */
  conversationId?: string;
}

/** What a tool's `execute` may return: text, or text plus app-only details. */
interface MaypopAgentToolResult {
  /** Text returned to the model. */
  text: string;
  /** Structured data for your own UI/logging — never shown to the model. */
  details?: unknown;
  /**
   * End the turn immediately after this tool instead of letting the model take
   * another turn. Set it on a tool that hands off to the user (an interactive
   * card, a final confirmation) so the loop doesn't add an empty trailing turn.
   */
  terminate?: boolean;
}

/**
 * One tool the agent can call. `parameters` is a JSON Schema object describing
 * the arguments; the runtime hands the model the schema and validates nothing
 * extra. `execute` does the work and returns a result for the model.
 */
interface MaypopAgentToolDef {
  /** Stable snake_case name the model calls. */
  name: string;
  /**
   * Short human-readable label for this tool's activity, shown while the call
   * runs (e.g. "Reading the board"). Surfaced as `label` on each tool call in
   * the transcript; falls back to a humanized `name` when omitted.
   */
  label?: string;
  /** What it does and when to use it — written for the model. */
  description: string;
  /** JSON Schema for the arguments object (e.g. `{ type: "object", properties: {…} }`). */
  parameters: Record<string, unknown>;
  /**
   * Run the call. Return a string (or {@link MaypopAgentToolResult}) for the
   * model. Throw to report failure — the runtime feeds the error back to the
   * model so it can recover.
   */
  execute: (
    params: Record<string, unknown>,
  ) => Promise<string | MaypopAgentToolResult> | string | MaypopAgentToolResult;
}

/** A starter suggestion. */
interface MaypopAgentChip {
  /** Short tappable label. */
  label: string;
  /** The prompt sent when tapped. */
  prompt: string;
}

/**
 * One transcript message, normalized for rendering. Messages stay in Pi's
 * chronological order. To match Maypop Studio, group messages between user
 * turns and render leading assistant text, then consolidated tool activity,
 * then the final assistant response. `tool` messages are completion metadata
 * for `toolCalls[].done`, not chat bubbles.
 */
interface MaypopAgentMessage {
  /** Who authored it. */
  role: "user" | "assistant" | "tool";
  /**
   * The concatenated text. For assistant messages this is markdown; while
   * `streaming` is true it grows token by token, so parse it incrementally.
   */
  text: string;
  /**
   * Tool calls the assistant requested in this message, if any. Each carries a
   * non-empty `label` (the tool's own, or a humanized name) for the "doing X"
   * affordance, and `done` — true once the call's result is in, so you can flip
   * that affordance from a spinner to a finished state.
   */
  toolCalls?: { name: string; arguments: unknown; label: string; done: boolean }[];
  /** True while this message is still streaming in. */
  streaming?: boolean;
}

/**
 * A live agent conversation. The transcript is pull-based: subscribe for a
 * change signal and re-read {@link getMessages} — don't try to diff events.
 */
interface MaypopAgentSession {
  /** Send a user message — starts or continues the conversation. */
  send(text: string): void;
  /** Abort the in-flight turn, if any. */
  abort(): void;
  /**
   * The full chronological transcript, including the in-flight streaming
   * message. Preserve its per-turn leading text → tools → final response
   * presentation order; do not hoist tool activity above the turn.
   */
  getMessages(): MaypopAgentMessage[];
  /** True while a turn is streaming. */
  readonly streaming: boolean;
  /** The id this session persists under, or null when ephemeral. */
  readonly conversationId: string | null;
  /**
   * Resolves once a resumed conversation's stored messages are loaded. For a
   * fresh or ephemeral session it resolves immediately. Await before reading
   * `getMessages()` if you passed a `conversationId`.
   */
  ready(): Promise<void>;
  /** The configured starter chips (normalized to `{ label, prompt }`). */
  readonly chips: MaypopAgentChip[];
  /** Subscribe to "something changed"; returns an unsubscribe fn. */
  subscribe(onChange: () => void): () => void;
}

// #endregion capability:agent

// #region capability:mcp

/**
 * This app's connected integrations — MCP servers **linked onto this app**
 * (connect in Settings, then Add on the app). Any service exposing an MCP server works (web
 * search, maps, project trackers, data APIs, …); there is no fixed catalog.
 * Tool calls run server-side with the connecting user's credentials; the app never
 * sees an API key. Gated by `mcp:use` (members only, never anonymous
 * guests) — so for a viewer with no account, `call()` throws
 * `maypop/sign-in-required` and asks the host for its sign-in card where a
 * sign-in would grant it (see {@link Maypop.signInRequired}). `servers()` and
 * `tools()` never raise that card, so feature-detection stays quiet.
 *
 * **Discover, don't assume.** Servers are admin-configured, so what exists —
 * and what its tools are called — varies per app. `servers()` lists what's
 * connected (names are admin-chosen display names, not stable keys), and
 * `tools()` returns each server's live tool definitions with JSON-Schema
 * parameters. Find capabilities by inspecting tool names/descriptions or
 * matching server names loosely, never by hardcoding ids. In app UI code,
 * invoke a tool with `call()`:
 *
 * ```js
 * await maypop.ready();
 * const [server] = await maypop.mcp.servers(); // feature-detect first
 * const tools = server ? await maypop.mcp.tools(server.id) : [];
 * const search = tools.find((t) => /search/i.test(t.name));
 * if (server && search) {
 *   const result = await maypop.mcp.call(server.id, search.name, {
 *     query: "coffee in Brooklyn",
 *   });
 *   if (!result.isError) {
 *     render(result.structuredContent ?? result.content);
 *   }
 * }
 * ```
 *
 * **Two result shapes — don't mix them.** `call()` resolves to the raw MCP
 * result (`{ content, structuredContent?, isError? }`); parse that in UI
 * code. The defs from `tools()` are for handing to an agent: their
 * `execute()` resolves to the agent shape (`{ text, details }`) and throws
 * on failure — a parser written for the raw shape reads empty from it.
 *
 * **Availability is per app.** An app with nothing linked sees `servers()`
 * resolve to `[]`, and tool calls fail. ALWAYS feature-detect and degrade
 * gracefully — hide or disable the integration-backed feature with a short
 * hint to Add the connection from the app details panel (Settings is only
 * where connections are created), and keep the rest of the app working.
 *
 * Results are tool-shaped, not UI-shaped — check `structuredContent` first,
 * fall back to the `content` text blocks, and attribute/cite external
 * results in the UI. Prefer rendering the structured result (lists, cards)
 * yourself; for a conversational surface, pass the tools to an agent
 * instead:
 *
 * ```js
 * const session = await maypop.agent.create({
 *   systemPrompt: "You help the group plan outings.",
 *   tools: await maypop.mcp.tools(),
 * });
 * ```
 */
interface MaypopMcp {
  /**
   * The integrations available to this session. Empty when none —
   * feature-detect on this before showing integration-backed UI.
   */
  servers(): Promise<MaypopMcpServer[]>;
  /**
   * Invoke one MCP tool. `args` must match the tool's `inputSchema` (see
   * {@link MaypopMcp.tools}). Resolves with the raw MCP result; check
   * `isError`, and prefer `structuredContent` when present, falling back to
   * the `content` text blocks.
   */
  call(
    serverId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<MaypopMcpToolResult>;
  /**
   * The connected servers' tools as ready-to-use agent tool definitions —
   * pass directly to `maypop.agent.create({ tools })`, or read `parameters`
   * (JSON Schema) to drive `call()` by hand. One server's tools when
   * `serverId` is given, else all connected servers'.
   */
  tools(serverId?: string): Promise<MaypopAgentToolDef[]>;
}

/** One connected integration, from {@link MaypopMcp.servers}. */
interface MaypopMcpServer {
  /** Pass to `call()`/`tools()`. Not stable across apps — never hardcode. */
  id: string;
  /** Admin-chosen display name, e.g. `"Exa"` — match loosely if at all. */
  name: string;
  /** The MCP server's endpoint, e.g. `"https://mcp.exa.ai/mcp"`. */
  url: string;
  /** Public identity for this connection (email or handle), when known. */
  account?: string | null;
}

/** Raw MCP tool result, from {@link MaypopMcp.call}. */
interface MaypopMcpToolResult {
  /** Content blocks; text blocks carry the human-readable result. */
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  /** Machine-readable result, when the tool provides one. Prefer this. */
  structuredContent?: unknown;
  /** True when the tool ran but failed — surface the text content as the error. */
  isError?: boolean;
}

// #endregion capability:mcp

// #region capability:link

/**
 * Link-preview metadata for a URL, from {@link MaypopLink.unfurl}. `url` is
 * always present (the final URL after redirects); every other field is
 * best-effort — a page may expose none of them, so always null-check before
 * rendering.
 */
interface LinkPreview {
  /** The final URL after redirects — what this metadata describes. */
  url: string;
  /** Page title (og:title / twitter:title / <title>). */
  title?: string;
  /** Short description (og:description / twitter:description / meta description). */
  description?: string;
  /**
   * Absolute URL of the preview image (og:image / Twitter card image) — this is
   * the REAL picture for the page. Relative image paths are already resolved to
   * absolute, so it's safe to drop straight into an `<img src>`.
   */
  image?: string;
  /** Human-readable site name (og:site_name), e.g. `"The Verge"`. */
  siteName?: string;
  /** Absolute URL of the site's favicon (falls back to `/favicon.ico`). */
  favicon?: string;
}

/**
 * Server-side link unfurling — the platform's way to "fetch a picture from the
 * internet" for a link.
 *
 * An app runs cross-origin in a sandboxed iframe, so it CANNOT `fetch()` an
 * arbitrary web page (browser CORS blocks it) and therefore can't read a page's
 * OpenGraph tags or its `og:image` on its own. `maypop.link.unfurl(url)` does
 * that fetch server-side and returns a compact {@link LinkPreview}.
 *
 * This is how you turn a WEB-SEARCH RESULT into a rich card with a real image:
 * web search (via {@link MaypopAi}) gives you article URLs and citations, but
 * not their images — unfurl a result's URL and use the returned `image`
 * (og:image) as the card's picture, plus `title`/`description`/`siteName` for
 * the text. Do NOT try to guess an image URL or hit a third-party image API
 * from app code; it will fail in the sandbox.
 *
 * ```js
 * const preview = await maypop.link.unfurl(result.url);
 * if (preview.image) img.src = preview.image;
 * title.textContent = preview.title ?? preview.url;
 * ```
 *
 * Only public `http`/`https` URLs are allowed (internal/private hosts are
 * rejected server-side), and the target must return an HTML page. Gated by
 * `identity:read`, which every session holds, so it works for members and
 * read-only share-link guests alike.
 */
interface MaypopLink {
  /**
   * Fetch preview metadata for a URL. Resolves with a {@link LinkPreview}
   * (`url` always set; the rest best-effort). Rejects with `maypop/error` for
   * an invalid or blocked URL (non-public host, non-http scheme) or a page that
   * isn't HTML — catch it and fall back to showing the bare URL.
   */
  unfurl(url: string): Promise<LinkPreview>;
}

// #endregion capability:link

/**
 * `window.maypop` — the frozen SDK surface.
 *
 * As capabilities are added they appear here as new namespaces. Fetch the
 * relevant section before using one; do not assume a method exists from its
 * name.
 */
interface Maypop {
  /**
   * Resolves after the host handshake and identity load complete. Idempotent —
   * safe to await repeatedly. ALWAYS await this before reading `user`/`mode` or
   * calling any capability; everything is null/unusable beforehand.
   *
   * ```js
   * await maypop.ready();
   * console.log("hello", maypop.user.username);
   * ```
   */
  ready(): Promise<void>;

  /** Which app instance this is. Null until `ready()`. See {@link MaypopAppContext}. */
  readonly app: MaypopAppContext | null;

  // #region capability:identity
  /** The current pseudonymous viewer. Null until `ready()`. See {@link MaypopUser}. */
  readonly user: MaypopUser | null;
  /**
   * "read-write" when the viewer may mutate (has `kv:write`), else
   * "read-only". A visitor who opened the app by its URL gets whatever that
   * URL grants — read-only for a `view` link, read-write for a `use` one —
   * except that a visitor with no account at all is always read-only, since a
   * write has to belong to somebody. Gate write UI on this, and listen for
   * `"modechange"` since it can flip at runtime.
   *
   * When it is "read-only", check {@link Maypop.signInRequired} before
   * settling for a view-only UI: it tells you whether signing in would make
   * this same viewer a writer.
   */
  readonly mode: MaypopMode;
  /** Granted scopes, for fine-grained capability sniffing (e.g. `"kv:write"`). */
  readonly permissions: string[];
  /**
   * True when `mode` is "read-only" ONLY because nobody is signed in: this
   * viewer opened the app by its URL without an account, and the link grants
   * writing to anyone who has one. Signing in through the same URL makes them
   * a writer. False when the viewer is already signed in, and false for an app
   * whose link is read-only for everybody — there, read-only is the answer and
   * a login would change nothing.
   *
   * It covers everything an account carries, not just writing: `ai:use` and
   * `mcp:use` are withheld from an account-less viewer too, and lifted by the
   * same sign-in.
   *
   * So when a capability is missing, this is what turns a dead end into an
   * offer: render your save / post / ask-the-AI control anyway, label it for
   * what it does, and call {@link Maypop.signIn} from it.
   *
   * ```js
   * if (maypop.mode === "read-only" && maypop.signInRequired) {
   *   saveBtn.textContent = "Sign in to save";
   *   saveBtn.onclick = () => maypop.signIn();
   * }
   * ```
   *
   * A write, or an AI or integration call, attempted anyway rejects with
   * `maypop/sign-in-required` (rather than `maypop/read-only` /
   * `maypop/forbidden`) and asks for the card on its own, so an app that
   * ignores all of this still leads somewhere. Discovery calls
   * (`ai.models()`, `mcp.servers()`, `mcp.tools()`) never raise it — they
   * answer, so you can build the offer before anyone presses anything.
   */
  readonly signInRequired: boolean;
  /**
   * Ask the host to open its sign-in card — for a "Sign in to save" control of
   * your own. Returns immediately and resolves nothing: signing in re-mints
   * the session and re-inits the app, so there is no result to await. Never
   * build a login screen inside the app; this is the only sign-in an app owns.
   */
  signIn(): void;
  /**
   * The path this app was opened at when launched from a deep-linked
   * notification (the `path` passed to `notify`), else `null`. Read once at
   * startup to route the initial screen; a HashRouter applies it automatically.
   */
  readonly launchPath: string | null;
  // #endregion capability:identity

  // #region capability:kv
  /** The app's shared key-value store — one per app. See {@link MaypopKv}. */
  readonly kv: MaypopKv;
  // #endregion capability:kv

  // #region capability:drive
  /** The app's private storage — durable file storage. See {@link MaypopDrive}. */
  readonly drive: MaypopDrive;
  // #endregion capability:drive

  // #region capability:ai
  /** The app's AI gateway (chat, decisions, images, music, audio, voices, sound effects, transcription) — gated by `ai:use`. See {@link MaypopAi}. */
  readonly ai: MaypopAi;
  // #endregion capability:ai

  // #region capability:members
  /**
   * Everyone who can reach this app — pseudonymous ids, roles, and who is
   * online right now. Requires the `group:read` scope.
   *
   * One round-trip snapshot, not a live stream: call it again to refresh (on
   * focus, or after your own writes land). `connected` is a few-minute
   * activity heuristic, so poll it rather than trusting it as presence.
   *
   * ```js
   * const { members, guestCount } = await maypop.members();
   * const online = members.filter((m) => m.connected);
   * renderFaces(online, guestCount);
   * ```
   *
   * The roster is the app's, not a group's: everyone who reaches this app
   * through any group it lives in, plus its author. It does not change with
   * how the current viewer opened the app.
   */
  members(): Promise<MaypopMemberList>;
  // #endregion capability:members

  // #region capability:apps
  /** Switch the viewer to another app by id. See {@link MaypopApps}. */
  readonly apps: MaypopApps;
  // #endregion capability:apps

  // #region capability:multiplayer
  /** Ephemeral live-session rooms over kv sync. See {@link MaypopMultiplayer}. */
  readonly multiplayer: MaypopMultiplayer;
  // #endregion capability:multiplayer

  // #region capability:agent
  /** Embedded conversational agent (chat + tool calling) — gated by `ai:use`. See {@link MaypopAgent}. */
  readonly agent: MaypopAgent;
  // #endregion capability:agent

  // #region capability:mcp
  /** Integrations available to this session — gated by `mcp:use`. See {@link MaypopMcp}. */
  readonly mcp: MaypopMcp;
  // #endregion capability:mcp

  // #region capability:link
  /** Server-side link unfurling — preview metadata + real og:image for a URL. See {@link MaypopLink}. */
  readonly link: MaypopLink;
  // #endregion capability:link

  // #region capability:share
  /**
   * Open a Maypop share card with a copyable deep link to a screen in this
   * app. `path` is a site-relative deep path (e.g. `"/item/42"`) — the same
   * form as `launchPath`; whoever opens the link lands on that screen (with a
   * HashRouter, automatically). The link is public when the app has an active
   * share link, otherwise scoped to group members. Resolves once the card is
   * shown.
   *
   * Rejects if `path` is invalid, or — commonly, while previewing an
   * unpublished app — with code `"maypop/share-unavailable"` and the message
   * "This app must be published to a group before you can share." That message
   * is written for end users, so you can show it directly. Wrap the call in
   * try/catch and surface it (a toast is ideal).
   */
  share(opts: { path: string; title?: string }): Promise<void>;
  // #endregion capability:share

  // #region capability:notify
  /**
   * Send a notification to people who use this app. It shows in their Maypop
   * notification bell, and on their lock screen if they enabled push.
   * Requires the `notify:send` scope — check `maypop.user.scopes` before
   * calling.
   *
   * `to` is `"all"` (everyone in the app except the sender) or an array of
   * member ids from `maypop.members()`. The reach is the app's own audience,
   * so it matches `members()` exactly; unknown or unreachable ids are dropped
   * silently, and an app can never address anyone outside it.
   *
   * `title` is plain text, max 120
   * chars; `body` plain text, max 500 chars. `path` (optional) deep-links
   * into your app: the recipient opening the notification lands on that
   * site-relative path (e.g. `"/poll/7"`). Read it back on open via
   * `maypop.launchPath`; with a HashRouter your router picks it up
   * automatically.
   *
   * Rate limits: 30 sends/hour per app instance (burst 10) and 5/hour to
   * the same recipient. Over-limit calls reject with `Error("rate_limited")`
   * and deliver nothing. Recipients can mute this app; muted sends are
   * silently dropped — apps get no delivery or read signal.
   */
  notify(opts: {
    to: "all" | string[];
    title: string;
    body?: string;
    path?: string;
  }): Promise<void>;
  // #endregion capability:notify

  /**
   * Always `false`. An app always runs against a real session, so there is
   * nothing to branch on — kept only so apps written against an older SDK,
   * back when a session-less mode existed, still read a boolean.
   *
   * @deprecated Nothing to check: the app is always fully attached.
   */
  readonly preview: boolean;

  /**
   * The host UI's light/dark theme. The SDK mirrors it onto
   * `<html data-theme>` and `color-scheme` for you, so theme-aware app styles
   * can follow it — read this (and listen for `"themechange"`) only for
   * visuals you render yourself, e.g. picking canvas or chart colors.
   * Defaults to `"dark"` until the host's first report.
   *
   * An app that deliberately pins a single theme can opt out of the automatic
   * document mutation with `<html data-maypop-theme="manual">`; this property
   * and `"themechange"` still track the host.
   */
  readonly theme: MaypopTheme;

  /**
   * Subscribe to a lifecycle event. Returns an unsubscribe function.
   *
   * ```js
   * const off = maypop.on("modechange", () => render());
   * // later: off();
   * ```
   */
  on(event: MaypopEvent, callback: () => void): () => void;
}

/** The complete public SDK type exported by the npm package. */
export type MaypopSdk = Maypop;
