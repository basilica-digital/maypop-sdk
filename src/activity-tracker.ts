// @ts-nocheck -- Runs as an injected classic script with deliberately tiny globals.
(() => {
  var port = null,
    currentToken = null;
  function onInit(e) {
    if (!e.data || e.data.type !== "maypop:activity-init" || !e.ports[0]) return;
    removeEventListener("message", onInit);
    port = e.ports[0];
    port.onmessage = function (m) {
      if (m.data && m.data.type === "maypop:activity-token") currentToken = m.data.token;
    };
  }
  addEventListener("message", onInit);

  var last = 0,
    PING_MS = 2000;
  function ping() {
    var now = Date.now();
    if (now - last < PING_MS || !port || !currentToken) return;
    last = now;
    var token = currentToken;
    currentToken = null; // single-use: must wait for the next token
    try {
      port.postMessage({ type: "maypop:activity", token: token });
    } catch (e) {}
  }
  ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"].forEach(function (t) {
    addEventListener(t, ping, { capture: true, passive: true });
  });
})();
