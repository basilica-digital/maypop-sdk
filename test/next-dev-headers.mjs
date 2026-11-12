// Starts `next dev` for the project directory given as the first argument,
// requests the paths given after it as documents Next serves itself, and
// prints each response's headers as JSON. Run as its own process by
// next.test.mjs: a Next development server keeps its watchers alive, so it
// ends with the process rather than inside the test runner.
import { createServer } from "node:http";

import next from "next";

const [root, ...paths] = process.argv.slice(2);
const app = next({ dev: true, dir: root, quiet: true });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => handle(request, response));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
for (const path of paths) {
  const response = await fetch(origin + path, {
    headers: { Accept: "text/html" },
  });
  await response.arrayBuffer();
  results.push({ path, headers: Object.fromEntries(response.headers) });
}
process.stdout.write(`\nRESULTS ${JSON.stringify(results)}\n`, () =>
  process.exit(0),
);
