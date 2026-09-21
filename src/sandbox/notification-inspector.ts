import type { AppMember, DevelopmentMode } from "./development.js";

export type NotificationRecord = {
  id: string;
  createdAt: string;
  sender: Pick<AppMember, "id" | "username">;
  requestedTo: "all" | string[];
  recipients: Array<Pick<AppMember, "id" | "username">>;
  title: string;
  body?: string;
  path?: string;
};

export type NotificationData = {
  schemaVersion: 1;
  notifications: NotificationRecord[];
};

/** Render the host-owned local notification outbox. */
export function notificationInspectorHtml(mode: DevelopmentMode): string {
  const modeJson = JSON.stringify(mode);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Maypop notifications</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
      header { display: flex; align-items: start; justify-content: space-between; gap: 24px; }
      h1 { margin: 0 0 6px; font-size: 24px; }
      p { color: color-mix(in srgb, currentColor 68%, transparent); }
      button { min-height: 36px; padding: 0 12px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
      ol { list-style: none; padding: 0; display: grid; gap: 12px; }
      article { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; padding: 16px; }
      article header { align-items: center; }
      h2 { margin: 0; font-size: 16px; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 14px 0 0; font-size: 13px; }
      dt { opacity: .58; } dd { margin: 0; overflow-wrap: anywhere; }
      .empty { padding: 48px 0; text-align: center; }
    </style>
  </head>
  <body>
    <header><div><h1>Notification outbox</h1><p>Captured locally in <strong id="mode"></strong> mode. Nothing on this page proves delivery.</p></div><button id="clear">Clear</button></header>
    <main><ol id="items"></ol><p class="empty" id="empty" hidden>No notifications captured yet.</p></main>
    <script>
      document.getElementById("mode").textContent = ${modeJson};
      const items = document.getElementById("items");
      const empty = document.getElementById("empty");
      const row = (label, value) => { const dt = document.createElement("dt"); dt.textContent = label; const dd = document.createElement("dd"); dd.textContent = value; return [dt, dd]; };
      async function load() {
        const data = await fetch("/_maypop/notifications.json", { cache: "no-store" }).then((r) => r.json());
        items.replaceChildren();
        empty.hidden = data.notifications.length > 0;
        for (const note of [...data.notifications].reverse()) {
          const li = document.createElement("li"); const article = document.createElement("article");
          const heading = document.createElement("h2"); heading.textContent = note.title;
          const time = document.createElement("time"); time.dateTime = note.createdAt; time.textContent = new Date(note.createdAt).toLocaleString();
          const head = document.createElement("header"); head.append(heading, time); article.append(head);
          const details = document.createElement("dl");
          const requested = note.requestedTo === "all" ? "All app members" : note.requestedTo.join(", ");
          const recipients = note.recipients.map((recipient) => "@" + recipient.username).join(", ") || "No recipients";
          for (const [label, value] of [["From", "@" + note.sender.username], ["Requested", requested], ["Resolved", recipients], ["Body", note.body || "—"], ["Path", note.path || "—"]]) details.append(...row(label, value));
          article.append(details); li.append(article); items.append(li);
        }
      }
      document.getElementById("clear").addEventListener("click", async () => { await fetch("/_maypop/notifications", { method: "DELETE" }); await load(); });
      load(); setInterval(load, 1500);
    </script>
  </body>
</html>`;
}
