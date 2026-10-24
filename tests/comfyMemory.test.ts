import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { ComfyClient } from "../src/comfy.js";

type Queue = { queue_running: unknown[]; queue_pending: unknown[] };

async function worker(t: TestContext, queues: unknown[], queueStatus = 200, freeStatus = 200) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  let checks = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url!, method: request.method!, body: body ? JSON.parse(body) : undefined });
    response.setHeader("content-type", "application/json");
    if (request.url === "/queue") {
      response.writeHead(queueStatus);
      response.end(JSON.stringify(queues[Math.min(checks++, queues.length - 1)]));
    } else if (request.url === "/free") {
      response.writeHead(freeStatus);
      response.end("{}");
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return {
    client: new ComfyClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    requests
  };
}

const idle: Queue = { queue_running: [], queue_pending: [] };

test("an idle worker receives a model and tensor release without deleting history or files", async t => {
  const { client, requests } = await worker(t, [idle]);
  assert.equal(await client.freeMemoryWhenIdle("wan-finished"), true);
  assert.deepEqual(requests, [
    { path: "/queue", method: "GET", body: undefined },
    { path: "/free", method: "POST", body: { unload_models: true, free_memory: true } }
  ]);
});

test("cleanup waits for its interrupted prompt to leave the worker before releasing memory", async t => {
  const { client, requests } = await worker(t, [
    { queue_running: [[0, "wan-stopping"]], queue_pending: [] }, idle
  ]);
  assert.equal(await client.freeMemoryWhenIdle("wan-stopping"), true);
  assert.deepEqual(requests.map(request => request.path), ["/queue", "/queue", "/free"]);
});

for (const [name, queue] of [
  ["another running prompt", { queue_running: [[0, "another"]], queue_pending: [] }],
  ["a queued prompt", { queue_running: [], queue_pending: [[1, "next"]] }],
  ["a queued prompt while the cancelled prompt is stopping", { queue_running: [[0, "wan-stopping"]], queue_pending: [[1, "next"]] }]
] as const) {
  test(`cleanup leaves the worker untouched when there is ${name}`, async t => {
    const { client, requests } = await worker(t, [queue]);
    assert.equal(await client.freeMemoryWhenIdle("wan-stopping"), false);
    assert.deepEqual(requests.map(request => request.path), ["/queue"]);
  });
}

test("cleanup stops waiting if another prompt starts before the worker becomes idle", async t => {
  const { client, requests } = await worker(t, [
    { queue_running: [[0, "wan-stopping"]], queue_pending: [] },
    { queue_running: [[1, "another"]], queue_pending: [] }
  ]);
  assert.equal(await client.freeMemoryWhenIdle("wan-stopping"), false);
  assert.deepEqual(requests.map(request => request.path), ["/queue", "/queue"]);
});

test("a cleanup deadline prevents hanging on a prompt that never stops", async t => {
  const { client, requests } = await worker(t, [
    { queue_running: [[0, "wan-stuck"]], queue_pending: [] }
  ]);
  await assert.rejects(client.freeMemoryWhenIdle("wan-stuck", AbortSignal.timeout(100)),
    (error: unknown) => error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.path === "/queue"));
});

test("an unreadable queue cannot trigger a global memory release", async t => {
  const { client, requests } = await worker(t, [{}]);
  await assert.rejects(client.freeMemoryWhenIdle("wan-finished"), /invalid queue response/);
  assert.deepEqual(requests.map(request => request.path), ["/queue"]);
});

test("a failed queue check cannot trigger a global memory release", async t => {
  const { client, requests } = await worker(t, [idle], 503);
  await assert.rejects(client.freeMemoryWhenIdle("wan-finished"), /queue check failed: 503/);
  assert.deepEqual(requests.map(request => request.path), ["/queue"]);
});

test("a rejected release request is reported as an error", async t => {
  const { client } = await worker(t, [idle], 200, 500);
  await assert.rejects(client.freeMemoryWhenIdle("wan-finished"), /memory release failed: 500/);
});
