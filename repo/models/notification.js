/**
 * models/notification.js
 *
 * In-memory data model for notification history.
 *
 * Each notification record has the shape:
 * {
 *   id:          {string}  — unique message ID (UUID v4)
 *   recipient:   {string}  — recipient email address
 *   subject:     {string}  — email subject line
 *   body:        {string}  — HTML email body
 *   status:      {string}  — "sent" | "failed"
 *   sentAt:      {string}  — ISO-8601 timestamp of when the record was created
 * }
 *
 * NOTE: This store is intentionally in-memory for this initial phase.
 *       Persistence (database) will be added in a follow-up step.
 */

"use strict";

const { randomUUID } = require("crypto");

/** @type {Array<Object>} */
const _store = [];

/**
 * Persist a new notification record and return it.
 *
 * @param {Object} params
 * @param {string} params.recipient  - Recipient email address
 * @param {string} params.subject    - Email subject
 * @param {string} params.body       - HTML email body
 * @param {"sent"|"failed"} params.status - Delivery status
 * @returns {Object} The saved notification record
 */
function create({ recipient, subject, body, status }) {
  const record = {
    id: randomUUID(),
    recipient,
    subject,
    body,
    status,
    sentAt: new Date().toISOString(),
  };
  _store.push(record);
  return record;
}

/**
 * Return all notification records, newest first.
 *
 * @returns {Array<Object>}
 */
function findAll() {
  return [..._store].reverse();
}

module.exports = { create, findAll };
