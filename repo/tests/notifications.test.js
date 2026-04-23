/**
 * tests/notifications.test.js
 *
 * Unit + integration tests for the POST /api/notifications/send endpoint.
 * Uses Node's built-in test runner (node --test) – no extra test framework
 * needed.  Nodemailer is replaced with a lightweight stub so no real SMTP
 * server is required.
 */

"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Import the module under test ─────────────────────────────────────────────
const {
  router,
  isValidEmail,
  buildHtmlBody,
  setTransporter,
  getTransporter,
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

// ── buildHtmlBody unit tests ──────────────────────────────────────────────────
describe("buildHtmlBody()", () => {
  test("returns a string containing the message text", () => {
    const html = buildHtmlBody("Hello, world!");
    assert.ok(html.includes("Hello, world!"));
  });

  test("wraps output in DOCTYPE html", () => {
    const html = buildHtmlBody("test");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
  });

  test("converts newlines to <br> tags", () => {
    const html = buildHtmlBody("line1\nline2");
    assert.ok(html.includes("<br>"));
  });

  test("escapes < and > characters", () => {
    const html = buildHtmlBody("<script>alert(1)</script>");
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("escapes & characters", () => {
    const html = buildHtmlBody("A & B");
    assert.ok(html.includes("A &amp; B"));
  });

  test("escapes double-quote characters", () => {
    const html = buildHtmlBody('say "hello"');
    assert.ok(html.includes("&quot;"));
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
    const { status, body } = await post(server, "/api/notifications/send", {
      to: "recipient@example.com",
      message: "Hello from the test suite!",
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.messageId, "string");
    assert.ok(body.messageId.length > 0);
  });

  test("sends to the correct recipient address", async () => {
    await post(server, "/api/notifications/send", {
      to: "alice@example.com",
      message: "Test message",
    });

    assert.equal(lastSentMail.to, "alice@example.com");
  });

  test("email subject is a non-empty string", async () => {
    await post(server, "/api/notifications/send", {
      to: "bob@example.com",
      message: "Check subject",
    });

    assert.equal(typeof lastSentMail.subject, "string");
    assert.ok(lastSentMail.subject.trim().length > 0);
  });

  test("email body is HTML (contains <html> tag)", async () => {
    await post(server, "/api/notifications/send", {
      to: "carol@example.com",
      message: "HTML check",
    });

    assert.ok(lastSentMail.html.includes("<html"));
  });

  test("email body contains the original message text", async () => {
    const message = "Unique message payload 12345";
    await post(server, "/api/notifications/send", {
      to: "dave@example.com",
      message,
    });

    assert.ok(lastSentMail.html.includes(message));
  });

  test("returns the messageId from the transporter response", async () => {
    const { body } = await post(server, "/api/notifications/send", {
      to: "eve@example.com",
      message: "messageId check",
    });

    assert.equal(body.messageId, "<test-message-id@stub>");
  });

  // ── Validation errors (400) ─────────────────────────────────────────────────
  test("returns 400 when `to` is missing", async () => {
    const { status, body } = await post(server, "/api/notifications/send", {
      message: "No recipient",
    });

    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `to` is not a valid email", async () => {
    const { status, body } = await post(server, "/api/notifications/send", {
      to: "not-an-email",
      message: "Bad address",
    });

    assert.equal(status, 400);
    assert.match(body.error, /invalid email/i);
  });

  test("returns 400 when `to` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      to: "",
      message: "Empty address",
    });

    assert.equal(status, 400);
  });

  test("returns 400 when `message` is missing", async () => {
    const { status, body } = await post(server, "/api/notifications/send", {
      to: "frank@example.com",
    });

    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  });

  test("returns 400 when `message` is an empty string", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      to: "grace@example.com",
      message: "",
    });

    assert.equal(status, 400);
  });

  test("returns 400 when `message` is whitespace only", async () => {
    const { status } = await post(server, "/api/notifications/send", {
      to: "henry@example.com",
      message: "   ",
    });

    assert.equal(status, 400);
  });

  // ── SMTP failure (500) ──────────────────────────────────────────────────────
  test("returns 500 when the transporter throws", async () => {
    setTransporter(makeStubTransporter({ shouldFail: true }));

    const { status, body } = await post(server, "/api/notifications/send", {
      to: "ivan@example.com",
      message: "This will fail",
    });

    assert.equal(status, 500);
    assert.match(body.error, /failed to send email/i);
  });
});
