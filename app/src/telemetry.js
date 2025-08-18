/**
 * telemetry.js — anonymous, opt-in telemetry for typasaur
 * - Prefers posthog-node SDK if available; otherwise falls back to raw HTTPS.
 * - Stores consent + anonymousId in ~/.typasaur.json.
 * - Never collects file contents, paths, or PII. Only: anonymousId, CLI flags (names only),
 *   Node version, OS, typasaur version.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

/** @typedef {{ telemetry?: boolean, anonymousId?: string }} TelemetryConfig */

/* =============================================================================
 * Constants
 * ========================================================================== */

const DOTFILE_BASENAME = ".typasaur.json";
const DEFAULT_INGEST_URL = "https://us.posthog.com";
const ENV_DISABLE = "TYPASAUR_TELEMETRY"; // "0" disables
const ENV_POSTHOG_KEY = "POSTHOG_KEY";
const ENV_POSTHOG_INGEST = "POSTHOG_INGEST";

/* =============================================================================
 * Optional SDK (posthog-node)
 * ========================================================================== */

let PostHogConstructor = null;
try {
  const { PostHog } = require("posthog-node");
  PostHogConstructor = PostHog;
} catch {
  // SDK not present; fallback path will be used.
}

/* =============================================================================
 * File I/O — config
 * ========================================================================== */

/** @returns {string} Absolute path to the user config file. */
function getUserConfigPath() {
  return path.join(os.homedir(), DOTFILE_BASENAME);
}

/** @returns {TelemetryConfig} */
function loadTelemetryConfig() {
  try {
    const raw = fs.readFileSync(getUserConfigPath(), "utf8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/** @param {TelemetryConfig} config */
function saveTelemetryConfig(config) {
  try {
    fs.writeFileSync(getUserConfigPath(), JSON.stringify(config, null, 2), "utf8");
  } catch {
    // Non-fatal. If we cannot persist, we simply skip.
  }
}

/* =============================================================================
 * Consent / preference
 * ========================================================================== */

/**
 * Return current telemetry preference, considering:
 * - hard off switches (env var / CLI flag)
 * - stored user consent in dotfile
 * - first-run prompt (only if interactive)
 *
 * @param {Record<string, any>} parsedArgs
 * @returns {Promise<boolean>} true if telemetry is allowed
 */
async function getOrEstablishTelemetryPreference(parsedArgs) {
  // Hard off switches
  if (String(process.env[ENV_DISABLE]) === "0") return false;
  if (parsedArgs && parsedArgs["no-telemetry"]) return false;

  const config = loadTelemetryConfig();
  if (typeof config.telemetry === "boolean") return config.telemetry;

  // Non-interactive environments (CI, piped, etc.) → default to false without prompting.
  if (!process.stdin.isTTY) {
    config.telemetry = false;
    saveTelemetryConfig(config);
    return false;
  }

  // Interactive first-run prompt
  const answer = await promptYesNo(
    "Allow anonymous usage telemetry to improve typasaur? (y/N): "
  );
  const allowed = answer === "y";
  config.telemetry = allowed;
  saveTelemetryConfig(config);
  return allowed;
}

/**
 * Update stored preference directly (useful for a future `typasaur --telemetry on|off`).
 * @param {"on"|"off"} value
 */
function updateTelemetryPreference(value) {
  const config = loadTelemetryConfig();
  config.telemetry = value === "on";
  saveTelemetryConfig(config);
}

/**
 * Human-readable status for CLI.
 * @returns {{enabled:boolean, reason:string, sdk:string}}
 */
function getTelemetryStatus() {
  if (String(process.env[ENV_DISABLE]) === "0") {
    return { enabled: false, reason: `${ENV_DISABLE}=0`, sdk: "n/a" };
  }
  const config = loadTelemetryConfig();
  if (typeof config.telemetry === "boolean") {
    return {
      enabled: !!config.telemetry,
      reason: "user preference",
      sdk: PostHogConstructor ? "posthog-node" : "https"
    };
  }
  return {
    enabled: false,
    reason: "no preference set (will prompt on interactive run)",
    sdk: PostHogConstructor ? "posthog-node" : "https"
  };
}

/* =============================================================================
 * Prompt
 * ========================================================================== */

/**
 * Simple yes/no line prompt (lowercase result).
 * @param {string} question
 * @returns {Promise<"y"|"n" | string>}
 */
function promptYesNo(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.on("line", (line) => {
      rl.close();
      resolve(String(line || "").trim().toLowerCase());
    });
  });
}

/* =============================================================================
 * Anonymous identity
 * ========================================================================== */

/** @returns {string} */
function getOrCreateAnonymousId() {
  const config = loadTelemetryConfig();
  if (config.anonymousId) return config.anonymousId;
  const id = crypto.randomUUID();
  config.anonymousId = id;
  saveTelemetryConfig(config);
  return id;
}

/* =============================================================================
 * Event capture
 * ========================================================================== */

/**
 * Capture a single "run" event (anonymous, minimal fields).
 * Safe to call even if keys are missing — it no-ops.
 * @param {Record<string, any>} parsedArgs
 */
function captureRunEvent(parsedArgs) {
  const posthogKey = process.env[ENV_POSTHOG_KEY];
  const ingestBase = String(process.env[ENV_POSTHOG_INGEST] || DEFAULT_INGEST_URL).replace(/\/$/, "");

  // Silently skip if no key configured
  if (!posthogKey) return;

  const anonymousId = getOrCreateAnonymousId();
  const payload = {
    distinct_id: anonymousId,
    os: process.platform,
    node: process.version,
    version: readPackageVersionSafely(),
    args: extractFlagNamesOnly(parsedArgs ? parsedArgs._rawArgv : process.argv.slice(2))
  };

  if (PostHogConstructor) {
    sendViaPosthogSdk(posthogKey, ingestBase, "typasaur_run", payload);
  } else {
    sendViaHttps(ingestBase, posthogKey, "typasaur_run", payload);
  }
}

/**
 * SDK path — uses posthog-node when available.
 * @param {string} key
 * @param {string} host
 * @param {string} eventName
 * @param {Record<string, any>} properties
 */
function sendViaPosthogSdk(key, host, eventName, properties) {
  try {
    const client = new PostHogConstructor(key, { host });
    client.capture({ distinctId: properties.distinct_id, event: eventName, properties });
    // Ensure we flush immediately for short-lived CLI processes
    // Use promise but do not block exit longer than ~1.5s
    client.shutdownAsync().catch(() => {});
  } catch {
    // Silently ignore telemetry errors.
  }
}

/**
 * Fallback path — minimal raw HTTPS POST to /capture/.
 * @param {string} ingestBase
 * @param {string} key
 * @param {string} eventName
 * @param {Record<string, any>} properties
 */
function sendViaHttps(ingestBase, key, eventName, properties) {
  try {
    const body = JSON.stringify({ api_key: key, event: eventName, properties });
    const req = https.request(
      `${ingestBase}/capture/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: 1500
      },
      (res) => res.resume()
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  } catch {
    // Silently ignore telemetry errors.
  }
}

/* =============================================================================
 * Helpers
 * ========================================================================== */

/**
 * Extract only flag names from argv, skipping values (to avoid paths/PII).
 * E.g. ["--model-name","User","--out","user.ts","--interface"] => ["--model-name","--out","--interface"]
 * @param {string[]|undefined} argv
 * @returns {string[]}
 */
function extractFlagNamesOnly(argv) {
  const raw = Array.isArray(argv) ? argv : [];
  const flags = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (!token || !token.startsWith("--")) continue;
    flags.push(token);
    const next = raw[i + 1];
    if (next && !next.startsWith("--")) i++; // skip its value
  }
  return flags;
}

/** @returns {string} */
function readPackageVersionSafely() {
  try {
    // Adjust path if your file structure differs
    const pkg = require("../../package.json");
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/* =============================================================================
 * Public API
 * ========================================================================== */

module.exports = {
  // Preference
  getOrEstablishTelemetryPreference,
  updateTelemetryPreference,
  getTelemetryStatus,

  // Event
  captureRunEvent,

  // Low-level (exposed for tests or advanced usage)
  loadTelemetryConfig,
  saveTelemetryConfig,
  getOrCreateAnonymousId,
  extractFlagNamesOnly
};