import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(
  new URL("./main.mjs", import.meta.url),
  "utf8",
);

test("does not anchor audio before the first captured packet", () => {
  assert.equal(mainSource.includes("preAudioSyncTimer"), false);
  assert.match(mainSource, /source:\s*"first-audio-packet"/);
});

test("marks both initial and resumed audio boundaries", () => {
  assert.match(
    mainSource,
    /audio\.packetsSent === 0 \|\| resumedAfterPause[\s\S]*?\? 0xe0[\s\S]*?: 0x60/,
  );
  assert.match(
    mainSource,
    /packet\[0\] = startBoundary \|\| !audio\.syncPackets \? 0x90 : 0x80/,
  );
});
