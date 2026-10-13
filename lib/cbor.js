// Minimal CBOR decoder for App Attest objects: maps, arrays, byte and text strings, integers.

export function decode(bytes) {
  const [value] = item(bytes, 0);
  return value;
}

function item(bytes, offset) {
  const initial = bytes[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let length = info;
  let next = offset + 1;
  if (info === 24) [length, next] = [bytes[next], next + 1];
  else if (info === 25) [length, next] = [(bytes[next] << 8) | bytes[next + 1], next + 2];
  else if (info === 26) [length, next] = [((bytes[next] << 24) >>> 0) + (bytes[next + 1] << 16) + (bytes[next + 2] << 8) + bytes[next + 3], next + 4];
  else if (info === 27) {
    length = 0;
    for (let index = 0; index < 8; index++) length = length * 256 + bytes[next + index];
    next += 8;
  } else if (info > 27) throw new Error("cbor: indefinite lengths are not supported");

  switch (major) {
    case 0: return [length, next];
    case 1: return [-1 - length, next];
    case 2: return [bytes.subarray(next, next + length), next + length];
    case 3: return [new TextDecoder().decode(bytes.subarray(next, next + length)), next + length];
    case 4: {
      const list = [];
      for (let index = 0; index < length; index++) {
        let value;
        [value, next] = item(bytes, next);
        list.push(value);
      }
      return [list, next];
    }
    case 5: {
      const map = {};
      for (let index = 0; index < length; index++) {
        let key, value;
        [key, next] = item(bytes, next);
        [value, next] = item(bytes, next);
        map[key] = value;
      }
      return [map, next];
    }
    case 6: return item(bytes, next); // tag: take the tagged value
    case 7: return [info === 20 ? false : info === 21 ? true : null, next];
  }
  throw new Error("cbor: bad item");
}
