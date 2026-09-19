const APPLE_EPOCH_MS = 978307200000;

function readUnsignedNumber(view, offset, size) {
  switch (size) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset);
    case 4:
      return view.getUint32(offset);
    case 8: {
      const value = view.getBigUint64(offset);

      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          "Binary plist structure exceeds JavaScript's safe integer range.",
        );
      }

      return Number(value);
    }
    default:
      throw new Error(`Unsupported binary plist integer size: ${size}.`);
  }
}

function readObjectInteger(view, offset, size) {
  if (size <= 4) {
    return readUnsignedNumber(view, offset, size);
  }

  let value = 0n;

  for (let index = 0; index < size; index += 1) {
    value =
      (value << 8n) |
      BigInt(view.getUint8(offset + index));
  }

  const signBit =
    1n << BigInt(size * 8 - 1);

  if (value & signBit) {
    value -=
      1n << BigInt(size * 8);
  }

  return value;
}

export function parseBinaryPlist(input) {
  const data =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input);

  const view =
    new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

  if (
    data.byteLength < 40 ||
    new TextDecoder("ascii")
      .decode(data.subarray(0, 8)) !==
      "bplist00"
  ) {
    throw new Error(
      "Invalid binary plist header.",
    );
  }

  const trailerOffset =
    data.byteLength - 32;

  const offsetSize =
    view.getUint8(trailerOffset + 6);

  const referenceSize =
    view.getUint8(trailerOffset + 7);

  const objectCount =
    readUnsignedNumber(
      view,
      trailerOffset + 8,
      8,
    );

  const rootReference =
    readUnsignedNumber(
      view,
      trailerOffset + 16,
      8,
    );

  const offsetTableOffset =
    readUnsignedNumber(
      view,
      trailerOffset + 24,
      8,
    );

  const offsets =
    Array.from(
      { length: objectCount },
      (_, index) =>
        readUnsignedNumber(
          view,
          offsetTableOffset +
            index * offsetSize,
          offsetSize,
        ),
    );

  const cache = new Map();

  function parseObject(reference) {
    if (cache.has(reference)) {
      return cache.get(reference);
    }

    let offset = offsets[reference];

    if (
      !Number.isInteger(offset) ||
      offset < 8 ||
      offset >= trailerOffset
    ) {
      throw new Error(
        `Invalid binary plist object reference ${reference}.`,
      );
    }

    const marker =
      view.getUint8(offset);

    const type =
      marker >> 4;

    let size =
      marker & 0x0f;

    offset += 1;

    if (
      type !== 0 &&
      type !== 8 &&
      size === 0x0f
    ) {
      const sizeMarker =
        view.getUint8(offset);

      if ((sizeMarker >> 4) !== 1) {
        throw new Error(
          "Invalid extended binary plist object size.",
        );
      }

      offset += 1;

      const sizeBytes =
        1 << (sizeMarker & 0x0f);

      size =
        readUnsignedNumber(
          view,
          offset,
          sizeBytes,
        );

      offset += sizeBytes;
    }

    let result;

    switch (type) {
      case 0x0:
        if (marker === 0x00) result = null;
        else if (marker === 0x08) result = false;
        else if (marker === 0x09) result = true;
        else throw new Error(
          `Unsupported binary plist singleton 0x${marker.toString(16)}.`,
        );
        break;

      case 0x1:
        result =
          readObjectInteger(
            view,
            offset,
            1 << size,
          );
        break;

      case 0x2: {
        const byteCount = 1 << size;
        if (byteCount === 4) {
          result = view.getFloat32(offset);
        } else if (byteCount === 8) {
          result = view.getFloat64(offset);
        } else {
          throw new Error(
            `Unsupported binary plist real size ${byteCount}.`,
          );
        }
        break;
      }

      case 0x3:
        result =
          new Date(
            view.getFloat64(offset) * 1000 +
              APPLE_EPOCH_MS,
          );
        break;

      case 0x4:
        result =
          Buffer.from(
            data.subarray(
              offset,
              offset + size,
            ),
          );
        break;

      case 0x5:
        result =
          new TextDecoder("ascii")
            .decode(
              data.subarray(
                offset,
                offset + size,
              ),
            );
        break;

      case 0x6: {
        let value = "";
        for (let index = 0; index < size; index += 1) {
          value += String.fromCharCode(
            view.getUint16(offset + index * 2),
          );
        }
        result = value;
        break;
      }

      case 0x8:
        result = {
          UID:
            readUnsignedNumber(
              view,
              offset,
              size + 1,
            ),
        };
        break;

      case 0xa:
      case 0xb:
      case 0xc: {
        result = [];
        cache.set(reference, result);
        for (let index = 0; index < size; index += 1) {
          const childReference =
            readUnsignedNumber(
              view,
              offset + index * referenceSize,
              referenceSize,
            );
          result.push(
            parseObject(childReference),
          );
        }
        break;
      }

      case 0xd: {
        result = {};
        cache.set(reference, result);
        for (let index = 0; index < size; index += 1) {
          const keyReference =
            readUnsignedNumber(
              view,
              offset + index * referenceSize,
              referenceSize,
            );

          const valueReference =
            readUnsignedNumber(
              view,
              offset +
                (size + index) * referenceSize,
              referenceSize,
            );

          result[String(parseObject(keyReference))] =
            parseObject(valueReference);
        }
        break;
      }

      default:
        throw new Error(
          `Unsupported binary plist object type 0x${type.toString(16)}.`,
        );
    }

    cache.set(reference, result);
    return result;
  }

  return parseObject(rootReference);
}
