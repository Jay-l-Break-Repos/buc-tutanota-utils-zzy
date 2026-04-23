/**
 * notifications.js
 *
 * Express router providing the POST /api/notifications/send endpoint.
 *
 * Accepts a recipient email address, a subject line, and an HTML body,
 * then dispatches the email via Nodemailer.
 *
 * Request body: { to: string, subject: string, body: string }
 *
 * Environment variables (all optional – sensible defaults are used for local
 * development / testing):
 *
 *   SMTP_HOST     – SMTP server hostname          (default: "localhost")
 *   SMTP_PORT     – SMTP server port              (default: 587)
 *   SMTP_SECURE   – "true" to use TLS on connect  (default: false)
 *   SMTP_USER     – SMTP auth username
 *   SMTP_PASS     – SMTP auth password
 *   MAIL_FROM     – Sender address                (default: "noreply@example.com")
 */

"use strict";

const express = require("express");
const nodemailer = require("nodemailer");

const router = express.Router();

// ── Email address validation ─────────────────────────────────────────────────
// RFC 5322-inspired regex that covers the vast majority of real-world addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns true when `address` is a syntactically valid email address.
 * @param {string} address
 * @returns {boolean}
 */
function isValidEmail(address) {
  return typeof address === "string" && EMAIL_RE.test(address.trim());
}

// ── Nodemailer transporter factory ──────────────────────────────────────────
/**
 * Builds and returns a Nodemailer transporter configured from environment
 * variables.  Exported so tests can swap it out via `setTransporter()`.
 */
function createTransporter() {
  const auth =
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    ...(auth ? { auth } : {}),
  });
}

// Allow tests (and future DI) to inject a custom transporter.
let _transporter = null;

/**
 * Replaces the active Nodemailer transporter.  Primarily used in tests.
 * @param {import("nodemailer").Transporter} transporter
 */
function setTransporter(transporter) {
  _transporter = transporter;
}

/**
 * Returns the active transporter, creating a default one on first call.
 * @returns {import("nodemailer").Transporter}
 */
function getTransporter() {
  if (!_transporter) {
    _transporter = createTransporter();
  }
  return _transporter;
}

// ── POST /api/notifications/send ─────────────────────────────────────────────
/**
 * @route  POST /api/notifications/send
 * @body   { to: string, subject: string, body: string }
 *
 * Sends an HTML notification email to the specified recipient.
 * The `body` field is used directly as the HTML email body.
 *
 * Success (200):
 *   { success: true, messageId: "<smtp-message-id>" }
 *
 * Validation errors (400):
 *   { error: "Invalid email address" }
 *   { error: "Missing required field: subject" }
 *   { error: "Missing required field: body" }
 *
 * Server error (500):
 *   { error: "Failed to send email: <reason>" }
 */
router.post("/send", async (req, res) => {
  const { to, subject, body } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────
  if (!isValidEmail(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!subject || typeof subject !== "string" || subject.trim() === "") {
    return res.status(400).json({ error: "Missing required field: subject" });
  }

  if (!body || typeof body !== "string" || body.trim() === "") {
    return res.status(400).json({ error: "Missing required field: body" });
  }

  // ── Build and send the email ───────────────────────────────────────────────
  const mailOptions = {
    from: process.env.MAIL_FROM || "noreply@example.com",
    to: to.trim(),
    subject: subject.trim(),
    html: body,
  };

  try {
    const info = await getTransporter().sendMail(mailOptions);
    return res.status(200).json({ success: true, messageId: info.messageId });
  } catch (err) {
    return res
      .status(500)
      .json({ error: `Failed to send email: ${err.message}` });
  }
});

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = { router, isValidEmail, setTransporter, getTransporter };
