#!/usr/bin/env node
// Run after compiling the source checkout:
// node tests/browser-idle.mjs dist/index.js
// Uses the actual compiled server with fake time and browser I/O; no Amazon login.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const compiledPath = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node tests/browser-idle.mjs dist/index.js");
const code = fs.readFileSync(compiledPath, "utf8");
const realRequire = createRequire(compiledPath);
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(timeout) {
  let now = 0;
  const timers = new Set();
  const handlers = new Map();
  const state = { contexts: [], launches: [], authGates: [], authError: null, closeGate: null, closeError: null, logs: [] };
  let httpHandler;
  class Server {
    setRequestHandler(schema, handler) { handlers.set(schema, handler); }
    async connect() {}
  }
  class AmazonPlugin {
    async checkAuthStatus(page) {
      assert.equal(page.isClosed(), false, "request must use an open page");
      await state.authGates.shift()?.promise;
      if (state.authError) throw state.authError;
      return { authenticated: true };
    }
    getLoginUrl() { return "https://example.invalid/login"; }
  }
  const chromium = {
    async launchPersistentContext(profile, options) {
      state.launches.push({ profile, options });
      const listeners = [];
      const context = {
        closed: false,
        closeCalls: 0,
        on(event, fn) { if (event === "close") listeners.push(fn); },
        pages() { return [page]; },
        async newPage() { return page; },
        async close() {
          this.closeCalls += 1;
          await state.closeGate?.promise;
          if (state.closeError) throw state.closeError;
          this.closed = true;
          for (const listener of listeners) listener();
        },
      };
      const page = { isClosed: () => context.closed };
      state.contexts.push(context);
      return context;
    },
  };
  const mocks = {
    "@modelcontextprotocol/sdk/server/index.js": { Server },
    "@modelcontextprotocol/sdk/server/stdio.js": { StdioServerTransport: class {} },
    "@modelcontextprotocol/sdk/server/streamableHttp.js": { StreamableHTTPServerTransport: class {} },
    "@modelcontextprotocol/sdk/types.js": { CallToolRequestSchema: "call", ListToolsRequestSchema: "list" },
    "playwright": { chromium },
    "./amazon/adapter": { AmazonPlugin },
    "./amazon/regions": { getRegionCodes: () => ["us"] },
    "./tools": {},
    "./amazon/extractors/transactions-page": {},
    "./amazon/extractors/gift-card": {},
    "node:http": { createServer(handler) { httpHandler = handler; return { listen(_port, _host, fn) { fn(); } }; } },
  };
  const env = { MCP_TRANSPORT: "streamable-http", AMAZON_ORDERS_BROWSER_DATA_DIR: "/test/profile" };
  if (timeout !== undefined) env.AMAZON_BROWSER_IDLE_TIMEOUT_MS = String(timeout);
  vm.runInNewContext(code, {
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name),
    exports: {},
    process: { env, on() {}, exit(code) { throw new Error("Unexpected exit: " + code); } },
    console: { error: (...args) => state.logs.push(args.join(" ")) },
    URL,
    setTimeout(fn, delay) {
      const timer = { fn, due: now + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
  }, { filename: compiledPath });
  await flush();
  return Object.assign(state, {
    async advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.due <= now && timers.delete(timer)) timer.fn();
      }
      await flush();
    },
    call: () => handlers.get("call")({ params: { name: "check_amazon_auth_status", arguments: { region: "us" } } }),
    list: () => handlers.get("list")(),
    async health() {
      if (!httpHandler) return; // Source server uses stdio; deployment adds HTTP.
      let status;
      await httpHandler({ url: "/healthz", headers: {} }, { writeHead(code) { status = code; }, end() {} });
      assert.equal(status, 200);
    },
    timerCount: () => timers.size,
  });
}

{
  const h = await harness();
  await h.call();
  assert.equal(h.launches[0].profile, "/test/profile");
  assert.equal(h.launches[0].options.channel, "chromium");
  assert.equal(h.launches[0].options.headless, true);
  assert.equal(Object.hasOwn(h.launches[0].options, "userAgent"), false);
  await h.advance(299999);
  assert.equal(h.contexts[0].closed, false);
  await h.health();
  await h.list();
  await h.advance(1);
  assert.equal(h.contexts[0].closed, true, "health/list must not reset idle time");
  await h.call();
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1].profile, h.launches[0].profile);
  console.log("PASS: five-minute default, health/list independence, reopen with same profile");
}
{
  const h = await harness();
  await h.call();
  await h.advance(240000);
  const gate = deferred();
  h.authGates.push(gate);
  const pending = h.call();
  await flush();
  await h.advance(600000);
  assert.equal(h.contexts[0].closed, false, "long tool calls must not be interrupted");
  gate.resolve();
  await pending;
  await h.advance(299999);
  assert.equal(h.contexts[0].closed, false);
  await h.advance(1);
  assert.equal(h.contexts[0].closed, true);
  console.log("PASS: idle timer resets and starts only after a long request finishes");
}
{
  const h = await harness();
  await h.call(); // Exercise overlapping requests with the existing browser.
  const first = deferred(), second = deferred();
  h.authGates.push(first, second);
  const a = h.call(), b = h.call();
  await flush();
  assert.equal(h.launches.length, 1, "overlapping requests reuse the open browser");
  first.resolve();
  await a;
  await h.advance(600000);
  assert.equal(h.contexts[0].closed, false);
  second.resolve();
  await b;
  await h.advance(300000);
  assert.equal(h.contexts[0].closed, true);
  console.log("PASS: overlapping requests share one browser and protect it until both finish");
}
{
  const h = await harness();
  await h.call();
  h.closeGate = deferred();
  await h.advance(300000);
  const pending = h.call();
  await flush();
  assert.equal(h.launches.length, 1, "must await closing before reusing profile");
  h.closeGate.resolve();
  await pending;
  assert.equal(h.launches.length, 2);
  assert.equal(h.contexts[0].closed, true);
  console.log("PASS: request arriving during close waits before upstream reopens the browser");
}
{
  const h = await harness();
  h.authError = new Error("simulated tool error");
  assert.equal((await h.call()).isError, true);
  await h.advance(300000);
  assert.equal(h.contexts[0].closed, true);
  console.log("PASS: tool failures still schedule idle cleanup");
}
{
  const h = await harness();
  await h.call();
  await h.advance(100000);
  await h.contexts[0].close();
  await h.call();
  await h.advance(200000);
  assert.equal(h.contexts[1].closed, false);
  await h.advance(100000);
  assert.equal(h.contexts[1].closed, true);
  console.log("PASS: manual closure clears stale state and the next request reopens");
}
{
  const disabled = await harness(0);
  await disabled.call();
  await disabled.advance(86400000);
  assert.equal(disabled.timerCount(), 0);
  assert.equal(disabled.contexts[0].closed, false);
  const custom = await harness(2000);
  await custom.call();
  await custom.advance(2000);
  assert.equal(custom.contexts[0].closed, true);
  for (const value of [-1, 1.5, "invalid", 2147483648]) {
    await assert.rejects(harness(value), /AMAZON_BROWSER_IDLE_TIMEOUT_MS/);
  }
  console.log("PASS: timeout override, disabling, and invalid configuration checks");
}
{
  const h = await harness(1000);
  await h.call();
  h.closeError = new Error("simulated close error");
  await h.advance(1000);
  assert.equal(h.contexts[0].closed, false);
  assert.equal(h.timerCount(), 1);
  h.closeError = null;
  await h.advance(1000);
  assert.equal(h.contexts[0].closed, true);
  console.log("PASS: failed close is handled and retried after another idle interval");
}
