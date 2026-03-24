#!/usr/bin/env node
/**
 * map-properties.mjs
 *
 * Maps raw device param_type numbers from a device properties JSON dump
 * to the corresponding property constants in eufy-security-client.
 *
 * Usage:
 *   node map-properties.mjs <raw-properties.json> [--closest]
 *   cat raw.json | node map-properties.mjs [--closest]
 *
 * The input JSON should be the rawProperties object from a device dump,
 * e.g. { "1101": { "value": 100 }, "1013": { "value": 1 }, ... }
 * or an array of { "param_type": 1101, "param_value": "..." } objects.
 *
 * Options:
 *   --closest   Find the closest existing devices by Jaccard similarity
 *               on resolved PropertyName overlap. Useful to identify which
 *               existing device to base the DeviceProperties block on.
 *
 * Output: a table mapping each param_type to its CommandType/ParamType enum name
 * and all property constants that use that key.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths relative to this script's location
// eufy-security-client is a sibling repo at the same level as homebridge-eufy-security
const CLIENT_ROOT = join(__dirname, "..", "..", "..", "..", "eufy-security-client");
const TYPES_HTTP = join(CLIENT_ROOT, "src", "http", "types.ts");
const TYPES_P2P = join(CLIENT_ROOT, "src", "p2p", "types.ts");

// ── Step 1: Parse enum values from source ──────────────────────────────────

function parseEnum(source, enumName) {
  const map = new Map(); // number → enum member name
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`, "m");
  const match = source.match(re);
  if (!match) return map;

  const body = match[1];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(\w+)\s*=\s*(\d+)/);
    if (m) {
      map.set(Number(m[2]), `${enumName}.${m[1]}`);
    }
  }
  return map;
}

const httpSource = readFileSync(TYPES_HTTP, "utf-8");
const p2pSource = readFileSync(TYPES_P2P, "utf-8");

const paramTypeMap = parseEnum(httpSource, "ParamType");
const commandTypeMap = parseEnum(p2pSource, "CommandType");
const trackerCommandTypeMap = parseEnum(p2pSource, "TrackerCommandType");

// Merge all enum maps (CommandType takes precedence as it's most commonly used)
const allEnums = new Map();
for (const [k, v] of paramTypeMap) allEnums.set(k, v);
for (const [k, v] of trackerCommandTypeMap) allEnums.set(k, v);
for (const [k, v] of commandTypeMap) allEnums.set(k, v);

// ── Step 2: Parse property constants and their keys ────────────────────────

// Match property constant definitions and extract their key field
// Handles both direct keys and spread patterns
function parsePropertyConstants(source) {
  const props = []; // { constName, key, keyRaw, propertyName }

  // Find each "export const XxxProperty" block
  const constRegex = /export\s+const\s+(\w+Property)\s*:\s*\w+\s*=\s*\{([\s\S]*?)\};/g;
  let m;
  while ((m = constRegex.exec(source)) !== null) {
    const constName = m[1];
    const body = m[2];

    // Extract key field
    let key = null;
    let keyRaw = null;
    const keyMatch = body.match(/key:\s*(.+?)(?:,|\n)/);
    if (keyMatch) {
      keyRaw = keyMatch[1].trim();
      // Resolve to numeric if it's an enum reference
      if (keyRaw.startsWith('"') || keyRaw.startsWith("'")) {
        key = keyRaw.replace(/['"]/g, ""); // string key
      } else {
        // It's an enum reference like CommandType.CMD_GET_BATTERY
        const parts = keyRaw.split(".");
        if (parts.length === 2) {
          const enumName = parts[0];
          let enumMap;
          if (enumName === "CommandType") enumMap = commandTypeMap;
          else if (enumName === "ParamType") enumMap = paramTypeMap;
          else if (enumName === "TrackerCommandType") enumMap = trackerCommandTypeMap;

          if (enumMap) {
            for (const [num, fullName] of enumMap) {
              if (fullName === keyRaw) {
                key = num;
                break;
              }
            }
          }
        }
      }
    }

    // Extract PropertyName
    let propertyName = null;
    const nameMatch = body.match(/name:\s*(PropertyName\.\w+)/);
    if (nameMatch) {
      propertyName = nameMatch[1];
    }

    // Handle spread: ...SomeOtherProperty (inherits key if not overridden)
    let spreadFrom = null;
    const spreadMatch = body.match(/\.\.\.(\w+Property)/);
    if (spreadMatch) {
      spreadFrom = spreadMatch[1];
    }

    props.push({ constName, key, keyRaw, propertyName, spreadFrom });
  }

  // Resolve spreads: inherit missing fields from parent property
  const byName = new Map(props.map((p) => [p.constName, p]));
  for (const prop of props) {
    if (prop.spreadFrom) {
      const parent = byName.get(prop.spreadFrom);
      if (parent) {
        if (prop.key === null) {
          prop.key = parent.key;
          if (!prop.keyRaw) prop.keyRaw = `(spread from ${prop.spreadFrom}) ${parent.keyRaw}`;
        }
        // Always inherit propertyName from parent when missing, even if key is overridden
        if (!prop.propertyName) prop.propertyName = parent.propertyName;
      }
    }
  }

  return props;
}

const allProps = parsePropertyConstants(httpSource);

// Build lookup: numeric key → list of property constants
const keyToProps = new Map(); // key (number|string) → [{ constName, propertyName }]
for (const p of allProps) {
  if (p.key === null) continue;
  const k = p.key;
  if (!keyToProps.has(k)) keyToProps.set(k, []);
  keyToProps.get(k).push({ constName: p.constName, propertyName: p.propertyName });
}

// ── Step 3: Parse DeviceProperties blocks to see which constants are used ──

function parseDevicePropertiesUsage(source) {
  // Find all [DeviceType.XXX]: { ... } blocks inside DeviceProperties
  const usage = new Map(); // constName → Set of DeviceType names that use it
  const dpRegex = /\[DeviceType\.(\w+)\]\s*:\s*\{([\s\S]*?)\}/g;
  // Only search within the DeviceProperties section
  const dpStart = source.indexOf("export const DeviceProperties");
  const dpEnd = source.indexOf("export const StationProperties");
  if (dpStart === -1) return usage;

  const dpSection = source.slice(dpStart, dpEnd === -1 ? undefined : dpEnd);
  let m;
  while ((m = dpRegex.exec(dpSection)) !== null) {
    const deviceType = m[1];
    const body = m[2];
    // Find all property constant references
    const refRegex = /:\s*(\w+Property)/g;
    let rm;
    while ((rm = refRegex.exec(body)) !== null) {
      const constName = rm[1];
      if (!usage.has(constName)) usage.set(constName, new Set());
      usage.get(constName).add(deviceType);
    }
  }
  return usage;
}

const propUsage = parseDevicePropertiesUsage(httpSource);

// ── Step 4: Read and parse input JSON ──────────────────────────────────────

let inputData;
const inputFile = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (inputFile) {
  inputData = readFileSync(inputFile, "utf-8");
} else {
  // Read from stdin
  inputData = readFileSync("/dev/stdin", "utf-8");
}

let rawParamTypes; // Set of numeric param_type values
try {
  const parsed = JSON.parse(inputData);

  if (Array.isArray(parsed)) {
    // Array of { param_type: number, ... }
    rawParamTypes = new Set(parsed.map((item) => Number(item.param_type)));
  } else if (typeof parsed === "object") {
    // Check if it's a full device dump with rawProperties nested
    if (parsed.rawProperties && typeof parsed.rawProperties === "object") {
      rawParamTypes = new Set(Object.keys(parsed.rawProperties).map(Number));
    } else {
      // Direct { "1101": ..., "1013": ... } format
      rawParamTypes = new Set(Object.keys(parsed).map(Number));
    }
  }
} catch {
  console.error("Error: Could not parse input JSON. Provide either:");
  console.error('  - A raw properties object: { "1101": {...}, "1013": {...}, ... }');
  console.error('  - An array: [{ "param_type": 1101, ... }, ...]');
  console.error("  - A device dump with rawProperties key");
  process.exit(1);
}

// Filter out NaN (from string keys in the input)
rawParamTypes = new Set([...rawParamTypes].filter((n) => !isNaN(n)));

// ── Step 5: Output results ─────────────────────────────────────────────────

const COL1 = 12; // param_type
const COL2 = 48; // enum name
const COL3 = 50; // property constants
// COL4 reserved for future use

const header = [
  "param_type".padEnd(COL1),
  "Enum Name".padEnd(COL2),
  "Property Constant(s)".padEnd(COL3),
  "Used by DeviceTypes",
].join(" | ");

console.log("=".repeat(header.length));
console.log("Device Raw Properties → Property Constants Mapping");
console.log(`Total raw param_types: ${rawParamTypes.size}`);
console.log("=".repeat(header.length));
console.log();
console.log(header);
console.log("-".repeat(header.length));

const matched = [];
const unmatched = [];

for (const paramType of [...rawParamTypes].sort((a, b) => a - b)) {
  const enumName = allEnums.get(paramType) || "???";
  const props = keyToProps.get(paramType);

  if (props && props.length > 0) {
    const constNames = props.map((p) => p.constName);
    const propertyNames = [...new Set(props.map((p) => p.propertyName).filter(Boolean))];
    const usedBy = new Set();
    for (const cn of constNames) {
      const devices = propUsage.get(cn);
      if (devices) devices.forEach((d) => usedBy.add(d));
    }

    matched.push({
      paramType,
      enumName,
      constNames,
      propertyNames,
      usedBy: [...usedBy],
    });

    console.log(
      [
        String(paramType).padEnd(COL1),
        enumName.padEnd(COL2),
        constNames.join(", ").padEnd(COL3),
        [...usedBy].slice(0, 5).join(", ") + (usedBy.size > 5 ? "..." : ""),
      ].join(" | ")
    );
  } else {
    unmatched.push({ paramType, enumName });
    console.log(
      [
        String(paramType).padEnd(COL1),
        enumName.padEnd(COL2),
        "(no property constant found)".padEnd(COL3),
        "",
      ].join(" | ")
    );
  }
}

console.log();
console.log("=".repeat(80));
console.log(`MATCHED: ${matched.length} / ${rawParamTypes.size} param_types have property constants`);
console.log(`UNMATCHED: ${unmatched.length} param_types have no known property constant`);
console.log("=".repeat(80));

if (unmatched.length > 0) {
  console.log();
  console.log("Unmatched param_types (may need new property constants or may be internal):");
  for (const u of unmatched) {
    console.log(`  ${u.paramType} → ${u.enumName}`);
  }
}

// ── Step 6: Companion custom properties ─────────────────────────────────────
// Some param_type-based properties require a companion custom (runtime) property
// that never appears in raw device data. Define those pairings here so the
// suggested block always includes both.

const COMPANION_PROPERTIES = new Map([
  // DeviceRTSPStream (CMD_NAS_SWITCH) → DeviceRTSPStreamUrl (custom_rtspStreamUrl)
  ["PropertyName.DeviceRTSPStream", {
    propertyName: "PropertyName.DeviceRTSPStreamUrl",
    constName: "DeviceRTSPStreamUrlProperty",
    reason: "RTSP URL is set at runtime by the station — must accompany DeviceRTSPStream",
  }],
  // DeviceWifiRSSI → DeviceWifiSignalLevel (custom_wifiSignalLevel)
  ["PropertyName.DeviceWifiRSSI", {
    propertyName: "PropertyName.DeviceWifiSignalLevel",
    constName: "DeviceWifiSignalLevelProperty",
    reason: "WiFi signal level is derived at runtime from RSSI",
  }],
  // DeviceCellularRSSI → DeviceCellularSignalLevel (custom_cellularSignalLevel)
  ["PropertyName.DeviceCellularRSSI", {
    propertyName: "PropertyName.DeviceCellularSignalLevel",
    constName: "DeviceCellularSignalLevelProperty",
    reason: "Cellular signal level is derived at runtime from RSSI",
  }],
]);

// Output a suggested PropertyName list for use in DeviceProperties block
console.log();
console.log("=".repeat(80));
console.log("SUGGESTED DeviceProperties block entries:");
console.log("=".repeat(80));
const seen = new Set();
const companionsAdded = [];
for (const m of matched) {
  // Use original props lookup to get correct constName → propertyName mapping
  // (the deduplicated m.propertyNames array loses the index association with m.constNames)
  const propsForKey = keyToProps.get(m.paramType) || [];
  for (const prop of propsForKey) {
    const pn = prop.propertyName;
    const cn = prop.constName;
    if (pn && !seen.has(pn)) {
      seen.add(pn);
      console.log(`  [${pn}]: ${cn},`);

      // Check if this property has a required companion
      const companion = COMPANION_PROPERTIES.get(pn);
      if (companion && !seen.has(companion.propertyName)) {
        seen.add(companion.propertyName);
        console.log(`  [${companion.propertyName}]: ${companion.constName},  // ⚠ companion (custom/runtime)`);
        companionsAdded.push(companion);
      }
    }
  }
}

if (companionsAdded.length > 0) {
  console.log();
  console.log("=".repeat(80));
  console.log("⚠  COMPANION PROPERTIES (custom/runtime — not in raw device data):");
  console.log("=".repeat(80));
  for (const c of companionsAdded) {
    console.log(`  ${c.constName}: ${c.reason}`);
  }
}

// ── Step 7: Closest device detection (--closest flag) ───────────────────────

if (process.argv.includes("--closest")) {
  // Collect the set of PropertyName values from the matched raw properties
  const targetPropNames = new Set();
  for (const m of matched) {
    for (const pn of m.propertyNames) {
      if (pn) targetPropNames.add(pn);
    }
  }

  if (targetPropNames.size === 0) {
    console.log("\nCannot compute closest device — no PropertyName matches found.");
  } else {
    // Parse DeviceProperties blocks to get property sets per device type
    const dpStart = httpSource.indexOf("export const DeviceProperties");
    const dpEnd = httpSource.indexOf("export const StationProperties");
    if (dpStart !== -1) {
      const dpSection = httpSource.slice(dpStart, dpEnd === -1 ? undefined : dpEnd);

      const devicePropSets = new Map(); // DeviceType name → Set of PropertyName references
      const blockRegex = /\[DeviceType\.(\w+)\]\s*:\s*\{([\s\S]*?)\}/g;
      let bm;
      while ((bm = blockRegex.exec(dpSection)) !== null) {
        const dt = bm[1];
        const body = bm[2];
        const props = new Set();
        // Extract property constants used, then resolve to PropertyName
        const refRegex = /:\s*(\w+Property)/g;
        let rm;
        while ((rm = refRegex.exec(body)) !== null) {
          const constName = rm[1];
          const prop = allProps.find((p) => p.constName === constName);
          if (prop && prop.propertyName) props.add(prop.propertyName);
        }
        devicePropSets.set(dt, props);
      }

      // Jaccard similarity
      const similarities = [];
      for (const [dt, props] of devicePropSets) {
        const intersection = new Set([...targetPropNames].filter((p) => props.has(p)));
        const union = new Set([...targetPropNames, ...props]);
        const jaccard = union.size > 0 ? intersection.size / union.size : 0;
        if (jaccard > 0.2) {
          similarities.push({
            device: dt,
            jaccard: Math.round(jaccard * 100),
            shared: intersection.size,
            targetOnly: [...targetPropNames].filter((p) => !props.has(p)).length,
            otherOnly: [...props].filter((p) => !targetPropNames.has(p)).length,
          });
        }
      }

      similarities.sort((a, b) => b.jaccard - a.jaccard);
      const top = similarities.slice(0, 8);

      console.log();
      console.log("=".repeat(80));
      console.log("CLOSEST EXISTING DEVICES (by property overlap with raw data)");
      console.log("=".repeat(80));
      if (top.length === 0) {
        console.log("  No devices with >20% property overlap found.");
      } else {
        console.log("  " + "Device".padEnd(38) + "Similarity  Shared  Target-only  Other-only");
        for (const d of top) {
          console.log(
            `  ${d.device.padEnd(38)} ${String(d.jaccard + "%").padEnd(11)} ${String(d.shared).padEnd(7)} ${String(d.targetOnly).padEnd(12)} ${d.otherOnly}`
          );
        }
        console.log();
        console.log(`  Recommended base: ${top[0].device} (${top[0].jaccard}% overlap)`);
      }
    }
  }
}
