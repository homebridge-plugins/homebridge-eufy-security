#!/usr/bin/env node
/**
 * check-device.mjs
 *
 * Pre-implementation audit for a new device type. Checks what already exists
 * in the codebase and what's missing before starting work.
 *
 * Usage:
 *   node check-device.mjs <device-type-number> [--pr-search <model>]
 *
 * Example:
 *   node check-device.mjs 105
 *   node check-device.mjs 203 --pr-search T85V0
 *
 * Output: status report showing what exists, what's missing, closest device,
 * and upstream PR search results.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLIENT_ROOT = join(__dirname, "..", "..", "..", "..", "eufy-security-client");
const HB_ROOT = join(__dirname, "..", "..", "..");
const TYPES_HTTP = join(CLIENT_ROOT, "src", "http", "types.ts");
const DEVICE_TS = join(CLIENT_ROOT, "src", "http", "device.ts");
const STATION_TS = join(CLIENT_ROOT, "src", "http", "station.ts");
const PUSH_SERVICE = join(CLIENT_ROOT, "src", "push", "service.ts");
const DEVICE_IMAGES = join(HB_ROOT, "homebridge-ui", "public", "utils", "device-images.js");

const typeNumber = parseInt(process.argv[2]);
if (isNaN(typeNumber)) {
  console.error("Usage: check-device.mjs <device-type-number> [--pr-search <model>]");
  console.error("Example: check-device.mjs 105");
  process.exit(1);
}

let prSearchTerm = null;
const prIdx = process.argv.indexOf("--pr-search");
if (prIdx !== -1 && process.argv[prIdx + 1]) {
  prSearchTerm = process.argv[prIdx + 1];
}

const httpSource = readFileSync(TYPES_HTTP, "utf-8");
const deviceSource = readFileSync(DEVICE_TS, "utf-8");

// ── Check 1: DeviceType enum ───────────────────────────────────────────────

function checkDeviceTypeEnum(source, typeNum) {
  const re = new RegExp(`^\\s*(\\w+)\\s*=\\s*${typeNum}\\s*[,/]`, "m");
  const match = source.match(re);
  return match ? match[1] : null;
}

const enumName = checkDeviceTypeEnum(httpSource, typeNumber);

// ── Check 2: GenericTypeProperty states ─────────────────────────────────────

function checkGenericTypePropertyStates(source, typeNum) {
  const gtpMatch = source.match(/export\s+const\s+GenericTypeProperty[\s\S]*?states:\s*\{([\s\S]*?)\}/);
  if (!gtpMatch) return null;
  const statesBody = gtpMatch[1];
  const entryRe = new RegExp(`${typeNum}:\\s*"([^"]+)"`);
  const match = statesBody.match(entryRe);
  return match ? match[1] : null;
}

const gtpLabel = checkGenericTypePropertyStates(httpSource, typeNumber);

// ── Check 3: DeviceProperties ──────────────────────────────────────────────

function checkLookupMap(source, mapName, enumN) {
  if (!enumN) return false;
  const dpStart = source.indexOf(`export const ${mapName}`);
  if (dpStart === -1) return false;
  // Find next export const to bound the search
  const nextExport = source.indexOf("export const ", dpStart + 20);
  const section = source.slice(dpStart, nextExport === -1 ? undefined : nextExport);
  return section.includes(`[DeviceType.${enumN}]`);
}

const inDeviceProperties = checkLookupMap(httpSource, "DeviceProperties", enumName);
const inStationProperties = checkLookupMap(httpSource, "StationProperties", enumName);
const inDeviceCommands = checkLookupMap(httpSource, "DeviceCommands", enumName);
const inStationCommands = checkLookupMap(httpSource, "StationCommands", enumName);

// ── Check 4: Classification methods in device.ts ───────────────────────────

function findClassificationMethods(source, enumN) {
  if (!enumN) return { inMethods: [], hasTypeGuard: false, hasInstanceMethod: false };

  const inMethods = [];
  // Find all static isXxx() methods and check if they reference this enum
  const methodRegex = /static\s+(is\w+)\s*\(\s*type:\s*number\s*\)[\s\S]*?\n\s*\}/g;
  let m;
  while ((m = methodRegex.exec(source)) !== null) {
    const methodName = m[1];
    const methodBody = m[0];
    if (methodBody.includes(`DeviceType.${enumN}`)) {
      inMethods.push(methodName);
    }
  }

  // Check for dedicated type guard (single-enum return)
  const hasTypeGuard = inMethods.some((name) => {
    const singleCheck = new RegExp(`static\\s+${name}\\s*\\(\\s*type:\\s*number\\s*\\)[^}]*return\\s+DeviceType\\.${enumN}\\s*==\\s*type`, "s");
    return singleCheck.test(source);
  });

  // If type guard exists, instance method likely does too
  const hasInstanceMethod = hasTypeGuard;

  return { inMethods, hasTypeGuard, hasInstanceMethod };
}

const classInfo = findClassificationMethods(deviceSource, enumName);

// ── Check 5: device-images.js ──────────────────────────────────────────────

function checkDeviceImages(typeNum) {
  if (!existsSync(DEVICE_IMAGES)) return null;
  const source = readFileSync(DEVICE_IMAGES, "utf-8");
  const re = new RegExp(`case\\s+${typeNum}:\\s*return\\s+'([^']+)'`);
  const match = source.match(re);
  return match ? match[1] : null;
}

const imageName = checkDeviceImages(typeNumber);

// ── Check 6: station.ts integration ─────────────────────────────────────────

function checkStationIntegration(enumN) {
  if (!enumN || !existsSync(STATION_TS)) return { referenced: false, methods: [] };
  const source = readFileSync(STATION_TS, "utf-8");
  const referenced = source.includes(`DeviceType.${enumN}`);
  // Also check via classification methods
  const methods = [];
  const methodRefs = source.match(/Device\.(is\w+)\(/g);
  if (methodRefs) {
    const uniqueMethods = [...new Set(methodRefs.map((m) => m.match(/Device\.(is\w+)/)[1]))];
    for (const method of uniqueMethods) {
      const re = new RegExp(`static\\s+${method}\\s*\\(\\s*type:\\s*number\\s*\\)[\\s\\S]*?\\n\\s*\\}`, "g");
      const match = deviceSource.match(re);
      if (match && match[0].includes(`DeviceType.${enumN}`)) {
        methods.push(method);
      }
    }
  }
  return { referenced, methods };
}

const stationInfo = checkStationIntegration(enumName);

// ── Check 6b: push/service.ts normalization ─────────────────────────────────

function checkPushService(enumN) {
  if (!enumN || !existsSync(PUSH_SERVICE)) return false;
  const source = readFileSync(PUSH_SERVICE, "utf-8");
  return source.includes(`DeviceType.${enumN}`);
}

const inPushService = checkPushService(enumName);

// ── Check 7: Find closest device by property overlap ───────────────────────

function findClosestDevice(source, enumN) {
  if (!enumN || !inDeviceProperties) return null;

  // Parse DeviceProperties section
  const dpStart = source.indexOf("export const DeviceProperties");
  const dpEnd = source.indexOf("export const StationProperties");
  if (dpStart === -1) return null;
  const dpSection = source.slice(dpStart, dpEnd === -1 ? undefined : dpEnd);

  // Extract property sets for each device
  const deviceProps = new Map();
  const blockRegex = /\[DeviceType\.(\w+)\]\s*:\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = blockRegex.exec(dpSection)) !== null) {
    const dt = m[1];
    const body = m[2];
    const props = new Set();
    const propRef = /\[PropertyName\.(\w+)\]/g;
    let pm;
    while ((pm = propRef.exec(body)) !== null) {
      props.add(pm[1]);
    }
    deviceProps.set(dt, props);
  }

  const targetProps = deviceProps.get(enumN);
  if (!targetProps || targetProps.size === 0) return null;

  // Jaccard similarity
  const similarities = [];
  for (const [dt, props] of deviceProps) {
    if (dt === enumN) continue;
    const intersection = new Set([...targetProps].filter((p) => props.has(p)));
    const union = new Set([...targetProps, ...props]);
    const jaccard = union.size > 0 ? intersection.size / union.size : 0;
    if (jaccard > 0.3) {
      similarities.push({
        device: dt,
        jaccard: Math.round(jaccard * 100),
        shared: intersection.size,
        total: union.size,
        targetOnly: [...targetProps].filter((p) => !props.has(p)).length,
        otherOnly: [...props].filter((p) => !targetProps.has(p)).length,
      });
    }
  }

  similarities.sort((a, b) => b.jaccard - a.jaccard);
  return similarities.slice(0, 5);
}

const closestDevices = findClosestDevice(httpSource, enumName);

// ── Check 7: Upstream PR search ────────────────────────────────────────────

// Sanitize shell arguments to prevent command injection
function shellEscape(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

function searchUpstreamPRs(searchTerm) {
  if (!searchTerm) return null;
  try {
    const result = execSync(
      `gh pr list --repo bropat/eufy-security-client --state all --search ${shellEscape(searchTerm)} --limit 5 --json number,title,state,mergedAt 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    );
    return JSON.parse(result);
  } catch {
    return null;
  }
}

// Also search by type number (typeNum is validated as integer, but escape for safety)
function searchByTypeNumber(typeNum) {
  try {
    const result = execSync(
      `gh pr list --repo bropat/eufy-security-client --state all --search ${shellEscape(String(typeNum))} --limit 5 --json number,title,state,mergedAt 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    );
    return JSON.parse(result);
  } catch {
    return null;
  }
}

const prsByModel = prSearchTerm ? searchUpstreamPRs(prSearchTerm) : null;
const prsByType = searchByTypeNumber(typeNumber);

// ── Output ─────────────────────────────────────────────────────────────────

const W = 80;
const PASS = "FOUND";
const FAIL = "MISSING";
const NA = "N/A";

console.log("=".repeat(W));
console.log(`Device Type Audit: ${typeNumber}${enumName ? ` (${enumName})` : ""}`);
console.log("=".repeat(W));
console.log();

// Registration status
console.log("REGISTRATION STATUS");
console.log("-".repeat(W));
const checks = [
  ["DeviceType enum", enumName ? `${PASS} — ${enumName}` : FAIL],
  ["GenericTypeProperty states", gtpLabel ? `${PASS} — "${gtpLabel}"` : FAIL],
  ["DeviceProperties map", inDeviceProperties ? PASS : FAIL],
  ["StationProperties map", inStationProperties ? PASS : `${FAIL} (may not be needed)`],
  ["DeviceCommands map", inDeviceCommands ? PASS : FAIL],
  ["StationCommands map", inStationCommands ? PASS : `${FAIL} (may not be needed)`],
];

for (const [label, status] of checks) {
  const icon = status.startsWith(PASS) ? "+" : status === NA ? " " : "-";
  console.log(`  [${icon}] ${label.padEnd(30)} ${status}`);
}

console.log();

// Classification methods
console.log("CLASSIFICATION METHODS");
console.log("-".repeat(W));
if (classInfo.inMethods.length > 0) {
  console.log(`  Included in ${classInfo.inMethods.length} method(s):`);
  for (const m of classInfo.inMethods) {
    console.log(`    - ${m}()`);
  }
  console.log(`  Dedicated type guard: ${classInfo.hasTypeGuard ? "YES" : "NO"}`);
} else if (enumName) {
  console.log("  Not included in any classification methods");
} else {
  console.log("  Cannot check — device type not in enum");
}
console.log();

// Device images
console.log("PLUGIN UI");
console.log("-".repeat(W));
console.log(`  device-images.js: ${imageName ? `${PASS} — ${imageName}` : FAIL}`);
console.log();

// Station & push integration
console.log("INTEGRATION POINTS");
console.log("-".repeat(W));
if (stationInfo.referenced) {
  console.log(`  station.ts: directly referenced`);
} else if (stationInfo.methods.length > 0) {
  console.log(`  station.ts: indirectly via ${stationInfo.methods.join(", ")}()`);
} else {
  console.log(`  station.ts: not referenced (may need integration for standalone/integrated devices)`);
}
console.log(`  push/service.ts: ${inPushService ? "referenced (has push normalization)" : "not referenced (normal for most devices)"}`);
console.log();

// Closest device
if (closestDevices && closestDevices.length > 0) {
  console.log("CLOSEST EXISTING DEVICES (by property overlap)");
  console.log("-".repeat(W));
  console.log("  Device".padEnd(40) + "Similarity  Shared  Target-only  Other-only");
  for (const d of closestDevices) {
    console.log(
      `  ${d.device.padEnd(38)} ${String(d.jaccard + "%").padEnd(11)} ${String(d.shared).padEnd(7)} ${String(d.targetOnly).padEnd(12)} ${d.otherOnly}`
    );
  }
  console.log();
}

// Upstream PRs
const allPRs = new Map();
if (prsByModel) for (const pr of prsByModel) allPRs.set(pr.number, pr);
if (prsByType) for (const pr of prsByType) allPRs.set(pr.number, pr);

if (allPRs.size > 0) {
  console.log("UPSTREAM PRs (bropat/eufy-security-client)");
  console.log("-".repeat(W));
  for (const pr of allPRs.values()) {
    const state = pr.mergedAt ? "MERGED" : pr.state;
    console.log(`  #${pr.number} [${state}] ${pr.title}`);
  }
  console.log();
}

// Summary
console.log("=".repeat(W));
const missing = checks.filter(([, s]) => s.startsWith(FAIL) && !s.includes("may not")).length;
const total = 4; // Required: enum, GTP, DeviceProperties, DeviceCommands
if (missing === 0) {
  console.log("STATUS: All required registrations present. Device may only need homebridge-side work.");
} else if (missing === total) {
  console.log("STATUS: Device is completely new. Full implementation needed across both repos.");
} else {
  console.log(`STATUS: Partially implemented. ${missing} required registration(s) missing.`);
}
console.log("=".repeat(W));
