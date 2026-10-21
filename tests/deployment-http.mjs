// Run after npm run build; no browser launch or Amazon access is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const compiledPath = path.resolve(process.argv[2] ?? "dist/index.js");
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
let logs = "";
const startup = process.env.MCP_START_SCRIPT;
const child = spawn(startup ? "bash" : process.execPath, [startup ?? compiledPath], {
  env: { ...process.env, MCP_TRANSPORT: "streamable-http", MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_PATH: "/custom-mcp" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const exited = once(child, "exit");
const origin = `http://127.0.0.1:${port}`;
async function rpc(id, method, params) {
  const response = await fetch(origin + "/custom-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(body)];
  const result = messages.find((message) => message.id === id);
  assert.ok(result, body);
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result.result;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(300) });
      if (response.ok) {
        assert.equal((await response.json()).status, "ok");
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "Server did not become healthy: " + logs);
  assert.equal((await fetch(origin + "/mcp")).status, 404);
  for (const client of [1, 2]) {
    const initialized = await rpc(client * 10, "initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "deployment-smoke", version: "1.0" },
    });
    assert.ok(initialized.serverInfo);
    const tools = await rpc(client * 10 + 1, "tools/list", {});
    assert.ok(tools.tools.some((tool) => tool.name === "check_amazon_auth_status"));
  }
  const error = await rpc(30, "tools/call", { name: "check_amazon_auth_status", arguments: { region: "invalid" } });
  assert.equal(error.isError, true);
  console.log("PASS: " + (startup ? "startup fetch/build and " : "") + "HTTP health, custom path, two client initializations and tool error response");
} finally {
  child.kill("SIGTERM");
  const [code, signal] = await Promise.race([exited, delay(5000).then(() => { child.kill("SIGKILL"); throw new Error("Server shutdown timed out: " + logs); })]);
  assert.ok(code === 0 || (startup && code === 143) || signal === "SIGTERM", logs);
}
