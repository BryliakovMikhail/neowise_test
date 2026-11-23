import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAppServer, triage, MODEL_TIMEOUT_MS } from "../server.mjs";
import { toView } from "../view.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

let server;
let baseUrl;
let originalWarn;

before(async () => {
  originalWarn = console.warn;
  console.warn = () => {};
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  console.warn = originalWarn;
});

function post(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/triage", () => {
  test("returns topic and draft for a normal request", async () => {
    const reply = await post({ text: "Какая цена у тарифа для юрлиц?" });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), {
      status: "ready",
      topic: "pricing",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  });

  for (const [name, body] of [
    ["empty text", { text: "" }],
    ["whitespace only", { text: "   \n " }],
    ["missing text", {}],
    ["text is not a string", { text: 42 }],
    ["body is null", "null"],
    ["broken json", "{\"text\": "],
  ]) {
    test(`rejects invalid input: ${name}`, async () => {
      const reply = await post(body);
      assert.equal(reply.status, 400);
      assert.deepEqual(await reply.json(), { status: "invalid_input" });
    });
  }

  for (const label of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`sends the request to manual review on ${label}`, async () => {
      const reply = await post({ text: `Где мой заказ? ${label}` });
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    });
  }

  test("stops waiting for the model after the timeout", async () => {
    const started = Date.now();
    const reply = await post({ text: "Где мой заказ? [timeout]" });
    const elapsed = Date.now() - started;
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    assert.ok(elapsed < 1000, `waited ${elapsed} ms, the mock model answers in 1200 ms`);
  });
});

test("times out even if the model ignores the abort signal", async () => {
  const neverAnswers = () => new Promise(() => {});
  const started = Date.now();
  const { result, reason } = await triage("Где мой заказ?", { classify: neverAnswers });
  assert.deepEqual(result, MANUAL_REVIEW);
  assert.equal(reason, "model timeout");
  assert.ok(Date.now() - started < MODEL_TIMEOUT_MS + 200);
});

describe("what the manager sees", () => {
  test("manual review clears the previous draft and asks to work by hand", () => {
    const success = toView(200, { status: "ready", topic: "delivery", draft: "Черновик" });
    assert.equal(success.draft, "Черновик");
    assert.equal(success.topic, "Доставка");

    const failure = toView(200, MANUAL_REVIEW);
    assert.equal(failure.kind, "manual");
    assert.equal(failure.draft, "");
    assert.equal(failure.topic, "");
    assert.match(failure.message, /вручную/);
  });

  test("a server error or a network failure is also shown as manual review", () => {
    assert.equal(toView(500, { status: "server_error" }).kind, "manual");
    assert.equal(toView(0, null).kind, "manual");
  });
});
