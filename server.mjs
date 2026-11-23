import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const TOPICS = new Set(["delivery", "pricing", "other"]);

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));
const viewJs = await readFile(new URL("./view.mjs", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class InvalidInput extends Error {}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("broken json");
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text is required");
  return text;
}

// Waits for the model no longer than timeoutMs. The signal lets the model stop early,
// and the race guarantees the timeout even if the model ignores the signal.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The model answer is untrusted: HTTP-level success says nothing about the content.
// Returns { topic, draft } or the reason why the answer cannot be shown to the manager.
export function checkModelOutput(raw) {
  if (typeof raw !== "string") return { reason: "output is not a string" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { reason: "output is not json" };
  }
  if (data === null || typeof data !== "object") return { reason: "output is not an object" };
  if (!TOPICS.has(data.topic)) return { reason: "unknown topic" };
  if (typeof data.draft !== "string" || data.draft.trim() === "") return { reason: "empty draft" };
  return { topic: data.topic, draft: data.draft.trim() };
}

export async function triage(text, { classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  let raw;
  try {
    raw = await callModel(classify, text, timeoutMs);
  } catch (error) {
    return { result: MANUAL_REVIEW, reason: error.message };
  }
  const checked = checkModelOutput(raw);
  if (checked.reason) return { result: MANUAL_REVIEW, reason: checked.reason };
  return { result: { status: "ready", topic: checked.topic, draft: checked.draft } };
}

export function createAppServer(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/view.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(viewJs);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = await readText(request);
      const { result, reason } = await triage(text, options);
      // The request text is not logged: it may contain client data.
      if (reason) console.warn(`triage: manual_review (${reason})`);
      json(response, 200, result);
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, INVALID_INPUT);
      console.error("triage: unexpected error", error);
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAppServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
