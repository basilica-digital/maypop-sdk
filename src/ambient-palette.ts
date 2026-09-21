// @ts-nocheck -- Runs as an injected classic script with canvas-specific globals.
/**
 * Ambient-palette reporter — injected into every served app document (see
 * `bundles::inject_serve_tags`).
 *
 * The host paints a soft glow behind the app's panels from the app's own
 * colours (YouTube's ambient mode). The host CANNOT read those colours: an
 * app runs in a sandboxed cross-origin iframe, and that isolation is the
 * point. So the app samples itself and posts a tiny palette out.
 *
 * Sampling is deliberately not a screenshot. Two sources, cheapest first:
 *
 *  1. MEDIA — the largest <video>/<canvas>/<img> actually covering a real
 *     share of the viewport, drawn into ONE reused 8x8 canvas. That is a
 *     ~64-pixel read, and for video it re-reads per tick, which is what makes
 *     the glow track the frame the way the reference does.
 *  2. SURFACES — `elementsFromPoint` at five fixed points, taking the first
 *     painted background in each stack. Five hit-tests, no tree walk, no
 *     layout thrash: O(1) whatever the app's DOM looks like.
 *
 * Everything else here exists to keep the cost at zero when nothing is
 * happening: a recursive timeout (so a slow tick can never stack), a hard
 * stop while the tab is hidden, and a perceptual change gate so a static app
 * posts exactly once and then goes quiet.
 *
 * The message is posted to `*`. Unlike the activity tracker — whose private
 * MessageChannel exists because it carries a single-use TOKEN — a palette is
 * three bytes of colour describing what is already on screen for anyone
 * looking at it, so there is nothing here to keep from an embedder.
 *
 * NOTHING RUNS UNTIL THE HOST ASKS. This file is injected into every served
 * app document, but only one kind of host reads what it produces, and on a
 * phone even that host renders no glow at all — panels go edge to edge, so
 * there is no gutter for one to live in. Sampling on spec would mean every
 * embedded app on every phone running a 2Hz loop whose messages nobody
 * reads. So the app says hello once and then waits: the host answers if it
 * wants a palette, and the silence is the common case. It also means the
 * whole feature can be turned off from the host, without a redeploy of the
 * server that injects this.
 */
(() => {
  if (window.top === window.self) return; // not embedded: nobody to tell

  var TICK_MS = 500; // 2Hz — under a video's frame rate, over a reader's eye
  var CANVAS_N = 8; // 8x8 = 64 pixels is plenty for an average
  var MIN_MEDIA_SHARE = 0.15; // media smaller than this isn't "what you see"
  var CHANGE_MIN = 10; // sum |dRGB| below this is not worth a message

  var canvas = null,
    ctx = null,
    lastSent = null,
    timer = null;

  /** Reused offscreen canvas — allocating one per tick is the whole cost. */
  function scratch() {
    if (!ctx) {
      canvas = document.createElement("canvas");
      canvas.width = CANVAS_N;
      canvas.height = CANVAS_N;
      // The context is read every tick; tell the compositor so it keeps the
      // surface CPU-side instead of round-tripping the GPU each readback.
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    return ctx;
  }

  function viewportArea() {
    return Math.max(1, innerWidth * innerHeight);
  }

  /** The one media element worth sampling, or null. */
  function dominantMedia() {
    var best = null,
      bestArea = viewportArea() * MIN_MEDIA_SHARE;
    var nodes = document.querySelectorAll("video, canvas, img");
    // Bounded: an app with hundreds of thumbnails shouldn't pay per node.
    var limit = Math.min(nodes.length, 40);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight) continue;
      if (r.right <= 0 || r.left >= innerWidth) continue;
      var area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
        Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  /** Average an element's pixels, or null if it can't be read. */
  function sampleMedia(el) {
    // A video with no frame yet, or an image still decoding, draws nothing —
    // sampling it would report black and flash the glow off.
    if (el.tagName === "VIDEO" && (el.readyState < 2 || !el.videoWidth)) return null;
    if (el.tagName === "IMG" && (!el.complete || !el.naturalWidth)) return null;
    if (el.tagName === "CANVAS" && (!el.width || !el.height)) return null;
    var c = scratch();
    try {
      c.drawImage(el, 0, 0, CANVAS_N, CANVAS_N);
      var d = c.getImageData(0, 0, CANVAS_N, CANVAS_N).data;
      var r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue; // transparent pixels aren't colour
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
      if (!n) return null;
      return [r / n, g / n, b / n];
    } catch (e) {
      // Tainted canvas (a cross-origin image inside the app). Nothing to do
      // but fall through to the surface sampler.
      return null;
    }
  }

  var RGB_RE = /^rgba?\(([^)]+)\)/;
  /** Parse a computed background, or null when it paints nothing. */
  function parseBg(value) {
    var m = RGB_RE.exec(value);
    if (!m) return null;
    var p = m[1].split(",");
    var a = p.length > 3 ? parseFloat(p[3]) : 1;
    if (!(a > 0.15)) return null; // effectively transparent
    return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])];
  }

  /** Five fixed probes across the viewport — the visible surfaces, O(1). */
  function sampleSurfaces() {
    var pts = [
      [0.5, 0.5],
      [0.2, 0.25],
      [0.8, 0.25],
      [0.2, 0.75],
      [0.8, 0.75],
    ];
    var r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0] * innerWidth,
        y = pts[i][1] * innerHeight;
      var stack = document.elementsFromPoint(x, y);
      for (var j = 0; j < stack.length; j++) {
        var bg = parseBg(getComputedStyle(stack[j]).backgroundColor);
        if (bg) {
          r += bg[0];
          g += bg[1];
          b += bg[2];
          n++;
          break; // the topmost painted surface at this point wins
        }
      }
    }
    if (n) return [r / n, g / n, b / n];
    // Every probe landed on a transparent stack — an app that paints nothing
    // at those five points, or paints with an image rather than a colour.
    // The document's own background is the last thing standing between that
    // and no glow at all.
    var root =
      parseBg(getComputedStyle(document.body).backgroundColor) ||
      parseBg(getComputedStyle(document.documentElement).backgroundColor);
    return root || null;
  }

  function changed(next) {
    if (!lastSent) return true;
    return (
      Math.abs(next[0] - lastSent[0]) +
        Math.abs(next[1] - lastSent[1]) +
        Math.abs(next[2] - lastSent[2]) >
      CHANGE_MIN
    );
  }

  function tick() {
    timer = null;
    if (!document.hidden) {
      var media = dominantMedia();
      var rgb = (media && sampleMedia(media)) || sampleSurfaces();
      if (rgb && changed(rgb)) {
        lastSent = rgb;
        try {
          parent.postMessage(
            {
              type: "maypop:ambient-palette",
              rgb: [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])],
            },
            "*",
          );
        } catch (e) {}
      }
    }
    schedule();
  }

  /** Recursive timeout, never setInterval: a tick that runs long must delay
   *  the next one rather than queue behind it. */
  function schedule() {
    if (timer) return;
    timer = setTimeout(tick, TICK_MS);
  }

  var started = false;
  /** The host wants a palette. Idempotent — it may ask more than once. */
  function start() {
    if (started) return;
    started = true;
    schedule();
  }

  addEventListener("message", function (e) {
    if (e.data && e.data.type === "maypop:ambient-start") start();
  });

  // Two orderings to cover, so both sides speak first. If the host was
  // already mounted it hears this hello and answers; if it mounts later it
  // broadcasts its own start to the frames it finds. Either way one message
  // is the entire cost to an app nobody is asking.
  try {
    parent.postMessage({ type: "maypop:ambient-hello" }, "*");
  } catch (e) {}

  // A hidden tab does no work at all, and wakes with an immediate sample so
  // the glow is right by the time the frame is visible again.
  document.addEventListener("visibilitychange", function () {
    if (!started) return;
    if (document.hidden) {
      clearTimeout(timer);
      timer = null;
    } else {
      lastSent = null; // re-report: the host may have reset while we slept
      clearTimeout(timer);
      timer = null;
      timer = setTimeout(tick, 0);
    }
  });

})();
