import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  createDiagnosticsArchive,
  makeDiagnosticsFilename,
  redactDiagnosticsValue,
} from "./diagnostics.mjs";

function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(compressed).toString("utf8") : compressed.toString("utf8"));
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("redacts pairing secrets, PINs, network identities, and profile paths", () => {
  const redacted = redactDiagnosticsValue({
    pin: "1234",
    sharedSecret: "do-not-export",
    address: "192.168.1.26",
    message: "PIN: 2468 at C:\\Users\\DiznyP\\Desktop from 10.0.0.4",
    receiver: "Living Room TV",
  });

  assert.equal(redacted.pin, "<redacted>");
  assert.equal(redacted.sharedSecret, "<redacted>");
  assert.equal(redacted.address, "<redacted>");
  assert.match(redacted.message, /PIN: <redacted>/);
  assert.match(redacted.message, /%USERPROFILE%/);
  assert.match(redacted.message, /<local-ip>/);
  assert.equal(redacted.receiver, "Living Room TV");
});

test("creates a readable privacy-safe diagnostics ZIP", () => {
  const archive = createDiagnosticsArchive({
    generatedAt: new Date("2026-08-31T12:34:56.000Z"),
    metadata: {
      app: { version: "1.0.1" },
      receivers: [{ name: "Living Room TV", model: "AppleTV5,3" }],
    },
    logTexts: [
      JSON.stringify({ at: "2026-08-31T12:00:00.000Z", event: "connection-state", status: "connected", deviceId: "AA:BB:CC:DD:EE:FF" }),
      JSON.stringify({ at: "2026-08-31T12:00:01.000Z", event: "video-stats", sentFrames: 60, sharedSecret: "secret-value" }),
      JSON.stringify({ at: "2026-08-31T12:00:02.000Z", event: "pin-submit", pin: "1234", digits: 4 }),
    ].join("\n"),
  });

  const entries = readZipEntries(archive.buffer);
  assert.deepEqual([...entries.keys()], [
    "README.txt",
    "summary.json",
    "connection-events.jsonl",
    "performance-events.jsonl",
    "performance-summary.json",
    "airspan-events-redacted.jsonl",
  ]);
  assert.match(entries.get("summary.json"), /AppleTV5,3/);
  assert.match(entries.get("performance-events.jsonl"), /video-stats/);
  const combined = [...entries.values()].join("\n");
  assert.doesNotMatch(combined, /secret-value|AA:BB:CC:DD:EE:FF|"1234"/);
  assert.match(combined, /<redacted>/);
});

test("uses a filesystem-safe timestamped filename", () => {
  assert.equal(
    makeDiagnosticsFilename(new Date("2026-08-31T12:34:56.789Z")),
    "AirSpan-Diagnostics-2026-08-31T12-34-56-789Z.zip",
  );
});
