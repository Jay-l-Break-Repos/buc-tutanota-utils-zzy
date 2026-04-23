/**
 * notifications.js
 *
 * Express router providing the notifications API:
 *
 *   POST /api/notifications/send
 *     Accepts { to, subject, body }, sends an HTML email, records the
 *     notification in an in-memory history store, and returns
 *     { success: true, messageId }.
 *
 *   GET  /api/notifications
 *     Returns the in-memory notification history as a JSON array.
 *     Each entry contains: { to, subject, sentAt, messageId }.
 *
 * Rate limiting: at most RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS
 * rolling window (per server process).  Excess requests receive 429.
 *
 * Environment variables (all optional):
 *
 *   SMTP_HOST          – SMTP server hostname  (omit → stub transport used)
 *   SMTP_PORT          – SMTP server port      (default: 587)
 *   SMTP_SECURE        – "true" for TLS        (default: false)
 *   SMTP_USER          – SMTP auth username
 *   SMTP_PASS          – SMTP auth password
 *   MAIL_FROM          – Sender address        (default: "noreply@example.com")
 *   RATE_LIMIT_MAX     – Max sends per window  (default: 10)
 *   RATE_LIMIT_WINDOW  – Window in ms          (default: 60000)
 */

"use strict";

const express = require("express");

const router = express.Router();

// ── Email address validation ─────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns true when `address` is a syntactically valid email address.
 * @param {string} address
 * @returns {boolean}
 */
function isValidEmail(address) {
  return typeof address === "string" && EMAIL_RE.test(address.trim());
}

// ── Nodemailer transporter ───────────────────────────────────────────────────
/**
 * Builds a Nodemailer transporter.
 *
 * When SMTP_HOST is not set (e.g. in CI / test environments with no real
 * SMTP server) a lightweight stub is returned that always resolves
 * successfully with a generated messageId.
 *
 * nodemailer is required lazily so the server starts cleanly even if the
 * package has not been installed (no-SMTP path never touches it).
 */
function createTransporter() {
  if (!process.env.SMTP_HOST) {
    // No SMTP server configured – use an in-process stub so the endpoint
    // still returns 200 in environments without a real mail server.
    return {
      sendMail(options) {
        return Promise.resolve({
          messageId: `<stub-${Date.now()}-${Math.random().toString(36).slice(2)}@localhost>`,
        });
      },
    };
  }

  // Only require nodemailer when a real SMTP host is configured.
  const nodemailer = require("nodemailer");

  const auth =
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    ...(auth ? { auth } : {}),
  });
}

// Allow tests (and future DI) to inject a custom transporter.
let _transporter = null;

/**
 * Replaces the active Nodemailer transporter.  Primarily used in tests.
 * @param {object|null} transporter
 */
function setTransporter(transporter) {
  _transporter = transporter;
}

/**
 * Returns the active transporter, lazily creating the default one.
 * @returns {object}
 */
function getTransporter() {
  if (!_transporter) {
    _transporter = createTransporter();
  }
  return _transporter;
}

// ── In-memory notification history ──────────────────────────────────────────
/**
 * Ordered list of successfully sent notifications.
 * Each entry: { to, subject, sentAt, messageId }
 *
 * Exported so tests can inspect / reset it directly.
 */
const notificationHistory = [];

/**
 * Clears the history array in place.  Used by tests between runs.
 */
function clearHistory() {
  notificationHistory.splice(0, notificationHistory.length);
}

// ── Rate limiter ─────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "10", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60000",
  10
);

// Sliding-window timestamps of accepted requests.
const _rateLimitTimestamps = [];

/**
 * Returns true when the current request is within the allowed rate.
 * Mutates _rateLimitTimestamps as a side-effect.
 */
function checkRateLimit() {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  // Drop timestamps outside the current window.
  while (_rateLimitTimestamps.length && _rateLimitTimestamps[0] < windowStart) {
    _rateLimitTimestamps.shift();
  }

  if (_rateLimitTimestamps.length >= RATE_LIMIT_MAX) {
    return false; // limit exceeded
  }

  _rateLimitTimestamps.push(now);
  return true;
}

/**
 * Resets the rate-limiter state.  Used by tests between runs.
 */
function resetRateLimit() {
  _rateLimitTimestamps.splice(0, _rateLimitTimestamps.length);
}

// ── POST /api/notifications/send ─────────────────────────────────────────────
/**
 * @route  POST /api/notifications/send
 * @body   { to: string, subject: string, body: string }
 *
 * Sends an HTML notification email to the specified recipient and records
 * the notification in the in-memory history store.
 *
 * Success (200):
 *   { success: true, messageId: string }
 *
 * Validation errors (400):
 *   { error: "Invalid email address" }
 *   { error: "Missing required field: subject" }
 *   { error: "Missing required field: body" }
 *
 * Rate limit exceeded (429):
 *   { error: "Too many requests" }
 *
 * Server error (500):
 *   { error: "Failed to send email: <reason>" }
 */
router.post("/send", async (req, res) => {
  // ── Rate limiting ────────────────────────────────────────────────────────
  if (!checkRateLimit()) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { to, subject, body } = req.body || {};

  // ── Input validation ─────────────────────────────────────────────────────
  if (!isValidEmail(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!subject || typeof subject !== "string" || subject.trim() === "") {
    return res.status(400).json({ error: "Missing required field: subject" });
  }

  if (!body || typeof body !== "string" || body.trim() === "") {
    return res.status(400).json({ error: "Missing required field: body" });
  }

  // ── Send email ───────────────────────────────────────────────────────────
  const mailOptions = {
    from: process.env.MAIL_FROM || "noreply@example.com",
    to: to.trim(),
    subject: subject.trim(),
    html: body,
  };

  try {
    const info = await getTransporter().sendMail(mailOptions);

    // ── Record in history ──────────────────────────────────────────────────
    notificationHistory.push({
      to: to.trim(),
      subject: subject.trim(),
      sentAt: new Date().toISOString(),
      messageId: info.messageId,
    });

    return res.status(200).json({ success: true, messageId: info.messageId });
  } catch (err) {
    return res
      .status(500)
      .json({ error: `Failed to send email: ${err.message}` });
  }
});

// ── GET /api/notifications ────────────────────────────────────────────────────
/**
 * @route  GET /api/notifications
 *
 * Returns the full in-memory notification history.
 *
 * Success (200):
 *   Array of { to, subject, sentAt, messageId }
 */
router.get("/", (req, res) => {
  return res.status(200).json(notificationHistory);
});

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  router,
  isValidEmail,
  setTransporter,
  getTransporter,
  notificationHistory,
  clearHistory,
  resetRateLimit,
};
