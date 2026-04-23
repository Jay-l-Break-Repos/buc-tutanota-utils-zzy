/**
 * tests/notifications.test.js
 *
 * Unit + integration tests for the notifications API.
 * Uses Node's built-in test runner (node --test) – no extra test framework
 * needed.  Nodemailer is replaced with a lightweight stub so no real SMTP
 * server is required.
 *
 * Endpoints under test:
 *   POST /api/notifications/send   { to, subject, body }
 *   GET  /api/notifications
 */

"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Import the module under test ─────────────────────────────────────────────
const {
  router,
  isValidEmail,
  setTransporter,
  notificationHistory,
  clearHistory,
  resetRateLimit,
} = require("../notifications");

// ── Minimal Express app wired up for testing ─────────────────────────────────
const express = require("express");
const http = require("node:http");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", router);
  return app;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(server, method, path, payload) {
  return new Promise((resolve, reject) => {
    const data = payload !== undefined ? JSON.stringify(payload) : null;
    const { port } = server.address();
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {}),
      },
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          reject(new Error(`JSON parse error: ${raw}`));
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const post = (server, path, payload) => request(server, "POST", path, payload);
const get  = (server, path)          => request(server, "GET",  path);

// ── Stub transporter factory ──────────────────────────────────────────────────
let lastSentMail = null;

function makeStubTransporter({ shouldFail = false } = {}) {
  return {
    sendMail(options) {
      if (shouldFail) {
        return Promise.reject(new Error("SMTP connection refused"));
      }
      lastSentMail = options;
      return Promise.resolve({ messageId: "<test-message-id@stub>" });
    },
  };
}

// ── Shared valid payload (mirrors task-1.spec.ts) ─────────────────────────────
const VALID_PAYLOAD = {
  to: "test@example.com",
  subject: "Contact Updated",
  body: "<h1>Hello</h1><p>Your contact was updated successfully.</p>",
};

// ── isValidEmail unit tests ───────────────────────────────────────────────────
describe("isValidEmail()", () => {
  test("accepts a standard email address", () => {
    assert.equal(isValidEmail("user@example.com"), true);
  });

  test("accepts an email with sub-domain", () => {
    assert.equal(isValidEmail("user@mail.example.co.uk"), true);
  });

  test("accepts an email with plus-addressing", () => {
    assert.equal(isValidEmail("user+tag@example.com"), true);
  });

  test("rejects an address with no @", () => {
    assert.equal(isValidEmail("notanemail"), false);
  });

  test("rejects an address with no domain part", () => {
    assert.equal(isValidEmail("user@"), false);
  });

  test("rejects an address with no TLD", () => {
    assert.equal(isValidEmail("user@domain"), false);
  });

  test("rejects an empty string", () => {
    assert.equal(isValidEmail(""), false);
  });

  test("rejects null", () => {
    assert.equal(isValidEmail(null), false);
  });

  test("rejects undefined", () => {
    assert.equal(isValidEmail(undefined), false);
  });

  test("rejects a number", () => {
    assert.equal(isValidEmail(42), false);
  });
});

// ── POST /api/notifications/send ──────────────────────────────────────────────
describe("POST /api/notifications/send", () => {
  let server;

  beforeEach(() => {
    lastSentMail = null;
    clearHistory();
    resetRateLimit();
    setTransporter(makeStubTransporter());
    server = buildApp().listen(0);
  });

  afterEach(() => {
    server.close();
    setTransporter(null);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  test("returns 200 with success:true and a messageId on valid input", async () => {
    const { status, body } = await post(server, "/api/notifications/send", VALID_PAYLOAD);

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.messageId, "string");
    assert.ok(body.messageId.length > 0);
  });

  test("messageId contains @", async () => {
    const { body } = await post(server, "/api/notifications/send", VALID_PAYLOAD);
    assert.ok(body.messageId.includes("@"));
  });

  test("sends to the correct recipient address", async () => {
    await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, to: "alice@example.com" });
    assert.equal(lastSentMail.to, "alice@example.com");
  });

  test("uses the provided subject line", async () => {
    await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, subject: "Contact Updated" });
    assert.equal(lastSentMail.subject, "Contact Updated");
  });

  test("email subject is a non-empty string", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    assert.equal(typeof lastSentMail.subject, "string");
    assert.ok(lastSentMail.subject.trim().length > 0);
  });

  test("email html field contains the provided body", async () => {
    const htmlBody = "<h1>Hello</h1><p>Your contact was updated successfully.</p>";
    await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, body: htmlBody });
    assert.ok(lastSentMail.html.includes(htmlBody));
  });

  test("returns the messageId from the transporter response", async () => {
    const { body } = await post(server, "/api/notifications/send", VALID_PAYLOAD);
    assert.equal(body.messageId, "<test-message-id@stub>");
  });

  // ── Validation errors (400) ─────────────────────────────────────────────────
  test("returns 400 when `to` is missing", async () => {
    const { to: _omit, ...payload } = VALID_PAYLOAD;
    const { status, body } = await post(server, "/api/notifications/send", payload);
    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `to` is not a valid email", async () => {
    const { status, body } = await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      to: "not-an-email",
    });
    assert.equal(status, 400);
    assert.match(body.error, /invalid email/i);
  });

  test("returns 400 when `to` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, to: "" });
    assert.equal(status, 400);
  });

  test("returns 400 when `subject` is missing", async () => {
    const { subject: _omit, ...payload } = VALID_PAYLOAD;
    const { status, body } = await post(server, "/api/notifications/send", payload);
    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `subject` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, subject: "" });
    assert.equal(status, 400);
  });

  test("returns 400 when `subject` is whitespace only", async () => {
    const { status } = await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, subject: "   " });
    assert.equal(status, 400);
  });

  test("returns 400 when `body` is missing", async () => {
    const { body: _omit, ...payload } = VALID_PAYLOAD;
    const { status, body } = await post(server, "/api/notifications/send", payload);
    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `body` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, body: "" });
    assert.equal(status, 400);
  });

  test("returns 400 when `body` is whitespace only", async () => {
    const { status } = await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, body: "   " });
    assert.equal(status, 400);
  });

  // ── SMTP failure (500) ──────────────────────────────────────────────────────
  test("returns 500 when the transporter throws", async () => {
    setTransporter(makeStubTransporter({ shouldFail: true }));
    const { status, body } = await post(server, "/api/notifications/send", VALID_PAYLOAD);
    assert.equal(status, 500);
    assert.match(body.error, /failed to send email/i);
  });

  // ── Rate limiting (429) ─────────────────────────────────────────────────────
  test("returns 429 after exceeding the rate limit", async () => {
    // Send RATE_LIMIT_MAX (10) requests – all should succeed.
    for (let i = 0; i < 10; i++) {
      const { status } = await post(server, "/api/notifications/send", {
        ...VALID_PAYLOAD,
        to: `user${i}@example.com`,
      });
      assert.equal(status, 200, `request ${i + 1} should succeed`);
    }

    // The 11th request must be rate-limited.
    const { status, body } = await post(server, "/api/notifications/send", VALID_PAYLOAD);
    assert.equal(status, 429);
    assert.ok(typeof body.error === "string");
  });
});

// ── GET /api/notifications (history) ─────────────────────────────────────────
describe("GET /api/notifications", () => {
  let server;

  beforeEach(() => {
    lastSentMail = null;
    clearHistory();
    resetRateLimit();
    setTransporter(makeStubTransporter());
    server = buildApp().listen(0);
  });

  afterEach(() => {
    server.close();
    setTransporter(null);
  });

  test("returns an empty array when no notifications have been sent", async () => {
    const { status, body } = await get(server, "/api/notifications");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  test("returns one entry after a successful send", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    const { status, body } = await get(server, "/api/notifications");
    assert.equal(status, 200);
    assert.equal(body.length, 1);
  });

  test("history entry contains `to` field", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    const { body } = await get(server, "/api/notifications");
    assert.equal(body[0].to, VALID_PAYLOAD.to);
  });

  test("history entry contains `subject` field", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    const { body } = await get(server, "/api/notifications");
    assert.equal(body[0].subject, VALID_PAYLOAD.subject);
  });

  test("history entry contains `sentAt` field", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    const { body } = await get(server, "/api/notifications");
    assert.ok(typeof body[0].sentAt === "string");
    assert.ok(body[0].sentAt.length > 0);
  });

  test("history entry contains `messageId` field", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    const { body } = await get(server, "/api/notifications");
    assert.ok(typeof body[0].messageId === "string");
    assert.ok(body[0].messageId.includes("@"));
  });

  test("accumulates multiple entries in order", async () => {
    await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, to: "a@example.com" });
    await post(server, "/api/notifications/send", { ...VALID_PAYLOAD, to: "b@example.com" });
    const { body } = await get(server, "/api/notifications");
    assert.equal(body.length, 2);
    assert.equal(body[0].to, "a@example.com");
    assert.equal(body[1].to, "b@example.com");
  });

  test("failed sends are NOT recorded in history", async () => {
    setTransporter(makeStubTransporter({ shouldFail: true }));
    await post(server, "/api/notifications/send", VALID_PAYLOAD);
    const { body } = await get(server, "/api/notifications");
    assert.equal(body.length, 0);
  });
});
