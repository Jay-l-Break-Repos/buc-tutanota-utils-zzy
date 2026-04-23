/**
 * tests/notifications.test.js
 *
 * Unit + integration tests for the POST /api/notifications/send endpoint.
 * Uses Node's built-in test runner (node --test) – no extra test framework
 * needed.  Nodemailer is replaced with a lightweight stub so no real SMTP
 * server is required.
 *
 * Request shape: { to: string, subject: string, body: string }
 */

"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Import the module under test ─────────────────────────────────────────────
const {
  router,
  isValidEmail,
  setTransporter,
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

// ── HTTP helper ───────────────────────────────────────────────────────────────
/**
 * Sends a POST request to the test server and resolves with
 * { status, body } where body is the parsed JSON response.
 */
function post(server, path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const { port } = server.address();
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
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
    req.write(data);
    req.end();
  });
}

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

// ── Shared valid payload ──────────────────────────────────────────────────────
const VALID_PAYLOAD = {
  to: "recipient@example.com",
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

// ── POST /api/notifications/send integration tests ───────────────────────────
describe("POST /api/notifications/send", () => {
  let server;

  beforeEach(() => {
    lastSentMail = null;
    // Install a fresh stub transporter before each test
    setTransporter(makeStubTransporter());
    server = buildApp().listen(0); // bind to a random free port
  });

  afterEach(() => {
    server.close();
    // Reset to null so the next test (or real usage) gets a fresh transporter
    setTransporter(null);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  test("returns 200 with success:true and a messageId on valid input", async () => {
    const { status, body } = await post(
      server,
      "/api/notifications/send",
      VALID_PAYLOAD
    );

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.messageId, "string");
    assert.ok(body.messageId.length > 0);
  });

  test("sends to the correct recipient address", async () => {
    await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      to: "alice@example.com",
    });

    assert.equal(lastSentMail.to, "alice@example.com");
  });

  test("uses the provided subject line", async () => {
    await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      subject: "Contact Updated",
    });

    assert.equal(lastSentMail.subject, "Contact Updated");
  });

  test("email subject is a non-empty string", async () => {
    await post(server, "/api/notifications/send", VALID_PAYLOAD);

    assert.equal(typeof lastSentMail.subject, "string");
    assert.ok(lastSentMail.subject.trim().length > 0);
  });

  test("email html field contains the provided body", async () => {
    const htmlBody = "<h1>Hello</h1><p>Your contact was updated successfully.</p>";
    await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      body: htmlBody,
    });

    assert.ok(lastSentMail.html.includes(htmlBody));
  });

  test("returns the messageId from the transporter response", async () => {
    const { body } = await post(
      server,
      "/api/notifications/send",
      VALID_PAYLOAD
    );

    assert.equal(body.messageId, "<test-message-id@stub>");
  });

  // ── Validation errors (400) ─────────────────────────────────────────────────
  test("returns 400 when `to` is missing", async () => {
    const { to: _omit, ...payload } = VALID_PAYLOAD;
    const { status, body } = await post(
      server,
      "/api/notifications/send",
      payload
    );

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
    const { status } = await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      to: "",
    });

    assert.equal(status, 400);
  });

  test("returns 400 when `subject` is missing", async () => {
    const { subject: _omit, ...payload } = VALID_PAYLOAD;
    const { status, body } = await post(
      server,
      "/api/notifications/send",
      payload
    );

    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `subject` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      subject: "",
    });

    assert.equal(status, 400);
  });

  test("returns 400 when `subject` is whitespace only", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      subject: "   ",
    });

    assert.equal(status, 400);
  });

  test("returns 400 when `body` is missing", async () => {
    const { body: _omit, ...payload } = VALID_PAYLOAD;
    const { status, body } = await post(
      server,
      "/api/notifications/send",
      payload
    );

    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `body` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      body: "",
    });

    assert.equal(status, 400);
  });

  test("returns 400 when `body` is whitespace only", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      ...VALID_PAYLOAD,
      body: "   ",
    });

    assert.equal(status, 400);
  });

  // ── SMTP failure (500) ──────────────────────────────────────────────────────
  test("returns 500 when the transporter throws", async () => {
    setTransporter(makeStubTransporter({ shouldFail: true }));

    const { status, body } = await post(
      server,
      "/api/notifications/send",
      VALID_PAYLOAD
    );

    assert.equal(status, 500);
    assert.match(body.error, /failed to send email/i);
  });
});
