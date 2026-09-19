import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBinaryPlist,
} from "./parse-binary-plist.mjs";

function makeClockPlist(clockID) {
  const header = Buffer.from("bplist00");
  const root = Buffer.from([0xd1, 0x01, 0x02]);
  const key = Buffer.concat([
    Buffer.from([0x57]),
    Buffer.from("ClockID"),
  ]);
  const integer = Buffer.alloc(9);
  integer[0] = 0x13;
  integer.writeBigUInt64BE(clockID, 1);
  const offsetTable = Buffer.from([8, 11, 19]);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(3n, 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(28n, 24);

  return Buffer.concat([
    header,
    root,
    key,
    integer,
    offsetTable,
    trailer,
  ]);
}

test("preserves a 64-bit ClockID exactly", () => {
  const expected = 0xfedcba9876543210n;
  const parsed = parseBinaryPlist(makeClockPlist(expected));

  assert.equal(
    BigInt.asUintN(64, parsed.ClockID),
    expected,
  );
});
