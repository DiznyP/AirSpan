import { deflateRawSync } from "node:zlib";

const MAX_DIAGNOSTIC_EVENTS = 4000;
const SENSITIVE_KEY =
  /(?:pin|passcode|password|secret|credential|privateKey|publicKey|signature|verificationKey|sessionKey|salt|proof|encrypted|authorization|token)/i;
const NETWORK_IDENTITY_KEY =
  /^(?:address|addresses|host|hostname|ip|deviceId|controllerId|accessoryIdentifier)$/i;

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sanitizeString(value) {
  return value
    .replace(/C:\\Users\\[^\\\s"']+/gi, "%USERPROFILE%")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<local-ip>")
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "<device-id>")
    .replace(/((?:pin|passcode|pairing code|code)\s*[:=]?\s*)\d{4,8}\b/gi, "$1<redacted>");
}

export function redactDiagnosticsValue(value, key = "") {
  if (SENSITIVE_KEY.test(key) || NETWORK_IDENTITY_KEY.test(key)) {
    return "<redacted>";
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticsValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactDiagnosticsValue(childValue, childKey),
      ]),
    );
  }

  return value;
}

export function parseDiagnosticLogs(logTexts, maxEvents = MAX_DIAGNOSTIC_EVENTS) {
  const events = [];
  const sources = Array.isArray(logTexts) ? logTexts : [logTexts];

  for (const text of sources) {
    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(redactDiagnosticsValue(JSON.parse(line)));
      } catch {
        // Skip malformed lines rather than risk exporting unstructured secrets.
      }
    }
  }

  events.sort((first, second) =>
    String(first?.at || "").localeCompare(String(second?.at || "")),
  );

  return events.slice(-Math.max(1, maxEvents));
}

function isConnectionEvent(event) {
  return /connection|socket-closed|device-(?:found|disappeared)|pairing-complete|renderer-gone|window-unresponsive/i
    .test(String(event?.event || ""));
}

function isPerformanceEvent(event) {
  const name = String(event?.event || "");
  if (/stats|audio-packet|video-frame-sent|audio-setup-ready|ptp-clock-ready|transport-ready/i.test(name)) {
    return true;
  }
  return name === "renderer-console" && /stats|audio|video|capture/i.test(String(event?.message || ""));
}

function jsonLines(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

function makePerformanceSummary(events) {
  const performanceEvents = events.filter(isPerformanceEvent);
  const latestByType = {};
  for (const event of performanceEvents) {
    latestByType[event.event || "unknown"] = event;
  }
  return {
    eventCount: performanceEvents.length,
    latestByType,
  };
}

function dosDateTime(date) {
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.max(1980, safeDate.getFullYear());
  return {
    date:
      ((year - 1980) << 9) |
      ((safeDate.getMonth() + 1) << 5) |
      safeDate.getDate(),
    time:
      (safeDate.getHours() << 11) |
      (safeDate.getMinutes() << 5) |
      Math.floor(safeDate.getSeconds() / 2),
  };
}

export function createZipBuffer(entries, modifiedAt = new Date()) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime(modifiedAt);

  for (const entry of entries) {
    const name = String(entry.name || "").replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.includes("../")) {
      throw new Error(`Unsafe diagnostic ZIP entry: ${name}`);
    }

    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ""), "utf8");
    const compressed = deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(stamp.time, 10);
    localHeader.writeUInt16LE(stamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(stamp.time, 12);
    centralHeader.writeUInt16LE(stamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function createDiagnosticsArchive({
  metadata,
  logTexts,
  generatedAt = new Date(),
}) {
  const events = parseDiagnosticLogs(logTexts);
  const connectionEvents = events.filter(isConnectionEvent);
  const performanceEvents = events.filter(isPerformanceEvent);
  const eventCounts = {};
  for (const event of events) {
    const name = String(event?.event || "unknown");
    eventCounts[name] = (eventCounts[name] || 0) + 1;
  }

  const summary = redactDiagnosticsValue({
    generatedAt: generatedAt.toISOString(),
    ...metadata,
    diagnostics: {
      eventCount: events.length,
      firstEventAt: events[0]?.at || null,
      lastEventAt: events.at(-1)?.at || null,
      eventCounts,
    },
  });

  const files = [
    {
      name: "README.txt",
      content:
        "AirSpan diagnostics bundle\r\n\r\n" +
        "This archive contains redacted runtime events, receiver model details, " +
        "connection history, and performance statistics. Pairing credentials, PINs, " +
        "cryptographic keys, device network addresses, and user-profile paths are excluded.\r\n",
    },
    {
      name: "summary.json",
      content: JSON.stringify(summary, null, 2) + "\n",
    },
    {
      name: "connection-events.jsonl",
      content: jsonLines(connectionEvents),
    },
    {
      name: "performance-events.jsonl",
      content: jsonLines(performanceEvents),
    },
    {
      name: "performance-summary.json",
      content: JSON.stringify(makePerformanceSummary(events), null, 2) + "\n",
    },
    {
      name: "airspan-events-redacted.jsonl",
      content: jsonLines(events),
    },
  ];

  return {
    buffer: createZipBuffer(files, generatedAt),
    files: files.map((file) => file.name),
    eventCount: events.length,
  };
}

export function makeDiagnosticsFilename(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `AirSpan-Diagnostics-${stamp}.zip`;
}
