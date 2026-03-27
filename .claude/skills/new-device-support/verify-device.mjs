#!/usr/bin/env node
/**
 * verify-device.mjs
 *
 * Post-implementation verification script. Checks that a device type is fully
 * wired into all required registration points after implementation.
 *
 * Usage:
 *   node verify-device.mjs <ENUM_NAME>
 *
 * Example:
 *   node verify-device.mjs CAMERA_4G_S330
 *   node verify-device.mjs INDOOR_PT_CAMERA_E30
 *
 * Output: PASS/FAIL per check, with a final summary.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLIENT_ROOT = join(__dirname, "..", "..", "..", "..", "eufy-security-client");
const HB_ROOT = join(__dirname, "..", "..", "..");
const TYPES_HTTP = join(CLIENT_ROOT, "src", "http", "types.ts");
const DEVICE_TS = join(CLIENT_ROOT, "src", "http", "device.ts");
const DEVICE_IMAGES = join(HB_ROOT, "homebridge-ui", "public", "utils", "device-images.js");
const SUPPORTED_DEVICES = join(CLIENT_ROOT, "docs", "supported_devices.md");

const enumName = process.argv[2];
if (!enumName || enumName.startsWith("-")) {
  console.error("Usage: verify-device.mjs <ENUM_NAME>");
  console.error("Example: verify-device.mjs CAMERA_4G_S330");
  process.exit(1);
}

const httpSource = readFileSync(TYPES_HTTP, "utf-8");
const deviceSource = readFileSync(DEVICE_TS, "utf-8");

// ── Extract type number from enum ───────────────────────────────────────────

function getTypeNumber(source, enumN) {
  const re = new RegExp(`^\\s*${enumN}\\s*=\\s*(\\d+)`, "m");
  const match = source.match(re);
  return match ? parseInt(match[1]) : null;
}

const typeNumber = getTypeNumber(httpSource, enumName);

// ── Check functions ─────────────────────────────────────────────────────────

function checkEnumExists(source, enumN) {
  const re = new RegExp(`^\\s*${enumN}\\s*=\\s*\\d+`, "m");
  return re.test(source);
}

function checkGenericTypePropertyStates(source, typeNum) {
  if (!typeNum) return { pass: false, detail: "no type number" };
  const gtpMatch = source.match(/export\s+const\s+GenericTypeProperty[\s\S]*?states:\s*\{([\s\S]*?)\}/);
  if (!gtpMatch) return { pass: false, detail: "GenericTypeProperty not found" };
  const re = new RegExp(`${typeNum}:\\s*"`);
  const found = re.test(gtpMatch[1]);
  return { pass: found, detail: found ? "label present" : "missing label entry" };
}

function checkLookupMap(source, mapName, enumN) {
  const dpStart = source.indexOf(`export const ${mapName}`);
  if (dpStart === -1) return { pass: false, detail: `${mapName} not found` };
  const nextExport = source.indexOf("export const ", dpStart + 20);
  const section = source.slice(dpStart, nextExport === -1 ? undefined : nextExport);
  const found = section.includes(`[DeviceType.${enumN}]`);
  return { pass: found, detail: found ? "entry present" : "missing entry" };
}

function checkTypeGuard(source, enumN) {
  // Look for a static method that returns DeviceType.ENUM == type
  const re = new RegExp(`static\\s+(is\\w+)\\s*\\(\\s*type:\\s*number\\s*\\)[^}]*DeviceType\\.${enumN}`, "g");
  const methods = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    methods.push(m[1]);
  }
  return {
    pass: methods.length > 0,
    detail: methods.length > 0 ? `found: ${methods.join(", ")}()` : "no type guard method references this enum",
  };
}

function checkInstanceMethod(source, enumN) {
  // Find methods from the type guard check, then look for matching instance methods
  const staticRe = new RegExp(`static\\s+(is\\w+)\\s*\\(\\s*type:\\s*number\\s*\\)[^}]*DeviceType\\.${enumN}`, "g");
  const staticMethods = [];
  let m;
  while ((m = staticRe.exec(source)) !== null) {
    staticMethods.push(m[1]);
  }

  const instanceMethods = [];
  for (const methodName of staticMethods) {
    const instanceRe = new RegExp(`public\\s+${methodName}\\s*\\(\\s*\\)\\s*:\\s*boolean`);
    if (instanceRe.test(source)) {
      instanceMethods.push(methodName);
    }
  }

  return {
    pass: instanceMethods.length > 0,
    detail: instanceMethods.length > 0
      ? `found: ${instanceMethods.join(", ")}()`
      : staticMethods.length > 0
        ? `static ${staticMethods.join(", ")}() found but missing instance method(s)`
        : "no type guard found",
  };
}

function checkClassificationMethods(source, enumN) {
  // Check broad classification methods (isCamera, isLock, isSensor, etc.)
  const broadMethods = [
    "isCamera", "isLock", "isSensor", "isKeyPad", "isSmartDrop",
    "isSmartSafe", "isSmartTrack", "hasBattery", "isFloodLight",
    "isIndoorCamera", "isDoorbell", "isPanAndTiltCamera",
    "isSoloCameras", "isLockWifi", "isLockBle", "isEntrySensor",
    "isMotionSensor",
  ];
  const included = [];
  for (const method of broadMethods) {
    const re = new RegExp(`static\\s+${method}\\s*\\(\\s*type:\\s*number\\s*\\)[\\s\\S]*?\\n\\s*\\}`, "g");
    const match = source.match(re);
    if (match && match[0].includes(`DeviceType.${enumN}`)) {
      included.push(method);
    }
  }
  return {
    pass: included.length > 0,
    detail: included.length > 0
      ? `in ${included.length} method(s): ${included.join(", ")}`
      : "not in any broad classification method",
  };
}

function checkDeviceImages(typeNum) {
  if (!typeNum) return { pass: false, detail: "no type number" };
  if (!existsSync(DEVICE_IMAGES)) return { pass: false, detail: "device-images.js not found" };
  const source = readFileSync(DEVICE_IMAGES, "utf-8");
  const re = new RegExp(`case\\s+${typeNum}:`);
  const found = re.test(source);
  return { pass: found, detail: found ? "case present" : "missing case" };
}

function checkSupportedDevicesDocs(enumN) {
  if (!existsSync(SUPPORTED_DEVICES)) return { pass: false, detail: "supported_devices.md not found" };
  const source = readFileSync(SUPPORTED_DEVICES, "utf-8");
  // Check for the enum name or the display name pattern
  const found = source.includes(enumN) || (typeNumber && new RegExp(`type\\s+${typeNumber}|${typeNumber}\\)`).test(source));
  // Also check for model number pattern from enum comment (e.g. "CAMERA_4G_S330 = 111, //T86P2")
  const enumLine = httpSource.match(new RegExp(`${enumN}\\s*=\\s*\\d+.*?//\\s*(\\S+)`));
  const model = enumLine ? enumLine[1] : null;
  const modelFound = model && source.includes(model);
  if (modelFound) return { pass: true, detail: `model ${model} found in docs` };
  if (found) return { pass: true, detail: "entry found in docs" };
  return { pass: false, detail: model ? `model ${model} not found` : "not found in docs" };
}

function checkBySn(source, enumN) {
  // Check if this device is referenced in any *BySn method
  // First get the model prefix from the enum comment
  const enumLine = httpSource.match(new RegExp(`${enumN}\\s*=\\s*\\d+.*?//\\s*(\\S+)`));
  const model = enumLine ? enumLine[1] : null;
  if (!model) return { pass: false, detail: "cannot determine model prefix from enum comment" };

  const bySnMethods = ["isIntegratedDeviceBySn", "isSoloCameraBySn", "isSmartDropBySn", "isGarageCameraBySn", "isFloodlightBySn"];
  const found = [];
  for (const method of bySnMethods) {
    const re = new RegExp(`static\\s+${method}\\s*\\([^)]*\\)[\\s\\S]*?\\n\\s*\\}`, "g");
    const match = source.match(re);
    if (match && match[0].includes(`"${model}"`)) {
      found.push(method);
    }
  }
  return {
    pass: found.length > 0,
    detail: found.length > 0
      ? `in ${found.join(", ")}()`
      : `model ${model} not in any *BySn method (may not be needed)`,
  };
}

// ── Run all checks ──────────────────────────────────────────────────────────

const W = 80;
console.log("=".repeat(W));
console.log(`Post-Implementation Verification: ${enumName}${typeNumber ? ` (type ${typeNumber})` : ""}`);
console.log("=".repeat(W));
console.log();

if (!typeNumber) {
  console.log(`FATAL: ${enumName} not found in DeviceType enum. Cannot proceed.`);
  process.exit(1);
}

const results = [];

function run(label, check, required = true) {
  const icon = check.pass ? "+" : required ? "-" : "~";
  const status = check.pass ? "PASS" : required ? "FAIL" : "WARN";
  results.push({ label, ...check, required, status });
  console.log(`  [${icon}] ${label.padEnd(35)} ${status.padEnd(6)} ${check.detail}`);
}

console.log("EUFY-SECURITY-CLIENT (src/http/types.ts)");
console.log("-".repeat(W));
run("DeviceType enum", { pass: checkEnumExists(httpSource, enumName), detail: `${enumName} = ${typeNumber}` });
run("GenericTypeProperty states", checkGenericTypePropertyStates(httpSource, typeNumber));
run("DeviceProperties map", checkLookupMap(httpSource, "DeviceProperties", enumName));
run("DeviceCommands map", checkLookupMap(httpSource, "DeviceCommands", enumName));
run("StationProperties map", checkLookupMap(httpSource, "StationProperties", enumName), false);
run("StationCommands map", checkLookupMap(httpSource, "StationCommands", enumName), false);
console.log();

console.log("EUFY-SECURITY-CLIENT (src/http/device.ts)");
console.log("-".repeat(W));
run("Dedicated type guard (static)", checkTypeGuard(deviceSource, enumName));
run("Instance method", checkInstanceMethod(deviceSource, enumName));
run("Classification methods", checkClassificationMethods(deviceSource, enumName));
console.log();

console.log("EUFY-SECURITY-CLIENT (docs)");
console.log("-".repeat(W));
run("docs/supported_devices.md", checkSupportedDevicesDocs(enumName), false);
console.log();

console.log("EUFY-SECURITY-CLIENT (serial number methods)");
console.log("-".repeat(W));
run("*BySn serial number methods", checkBySn(deviceSource, enumName), false);
console.log();

console.log("HOMEBRIDGE-EUFY-SECURITY");
console.log("-".repeat(W));
run("device-images.js", checkDeviceImages(typeNumber));
console.log();

// ── Summary ─────────────────────────────────────────────────────────────────

const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
const passed = results.filter((r) => r.status === "PASS");

console.log("=".repeat(W));
if (failed.length === 0) {
  console.log(`ALL REQUIRED CHECKS PASSED (${passed.length} pass, ${warned.length} warn)`);
  if (warned.length > 0) {
    console.log("Warnings (optional):");
    for (const w of warned) {
      console.log(`  - ${w.label}: ${w.detail}`);
    }
  }
} else {
  console.log(`${failed.length} REQUIRED CHECK(S) FAILED:`);
  for (const f of failed) {
    console.log(`  - ${f.label}: ${f.detail}`);
  }
  if (warned.length > 0) {
    console.log(`\n${warned.length} warning(s):`);
    for (const w of warned) {
      console.log(`  - ${w.label}: ${w.detail}`);
    }
  }
}
console.log("=".repeat(W));

process.exit(failed.length > 0 ? 1 : 0);
