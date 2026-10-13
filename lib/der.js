// Just enough DER and X.509 to check Apple's certificate chains with WebCrypto.

export function tlv(bytes, offset = 0) {
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + bytes[offset + 2 + index];
    header += count;
  }
  const start = offset + header;
  const end = start + length;
  if (end > bytes.length) throw new Error("der: truncated");
  return { tag, end, value: bytes.subarray(start, end), all: bytes.subarray(offset, end) };
}

export function items(bytes) {
  const list = [];
  for (let offset = 0; offset < bytes.length; ) {
    const item = tlv(bytes, offset);
    list.push(item);
    offset = item.end;
  }
  return list;
}

export function oid(bytes) {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function time(item) {
  const text = new TextDecoder().decode(item.value);
  // UTCTime YYMMDDHHMMSSZ or GeneralizedTime YYYYMMDDHHMMSSZ.
  const full = item.tag === 0x17 ? (Number(text.slice(0, 2)) < 50 ? "20" : "19") + text : text;
  return Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14));
}

const CURVES = { "1.2.840.10045.3.1.7": ["P-256", 32], "1.3.132.0.34": ["P-384", 48] };
const HASHES = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384" };

export function certificate(der) {
  const [tbs, algorithm, signature] = items(tlv(der).value);
  const fields = items(tbs.value);
  const rest = fields[0].tag === 0xa0 ? fields.slice(1) : fields; // skip [0] version
  const [, , issuer, validity, subject, spki] = rest;
  const extensions = new Map();
  const wrapped = rest.find((field) => field.tag === 0xa3);
  if (wrapped) {
    for (const extension of items(tlv(wrapped.value).value)) {
      const parts = items(extension.value);
      extensions.set(oid(parts[0].value), parts[parts.length - 1].value); // OCTET STRING contents
    }
  }
  const [notBefore, notAfter] = items(validity.value).map(time);
  const [keyAlgorithm, keyBits] = items(spki.value);
  const curveOid = oid(items(keyAlgorithm.value)[1].value);
  return {
    der,
    tbs: tbs.all,
    hash: HASHES[oid(items(algorithm.value)[0].value)],
    signature: signature.value.subarray(1), // BIT STRING: drop the unused-bits byte
    issuer: issuer.all,
    subject: subject.all,
    notBefore,
    notAfter,
    spki: spki.all,
    point: keyBits.value.subarray(1), // 0x04 || X || Y
    curve: CURVES[curveOid],
    extensions,
  };
}

/// DER SEQUENCE { r INTEGER, s INTEGER } -> r || s, as WebCrypto wants.
export function rawSignature(der, size) {
  const out = new Uint8Array(size * 2);
  items(tlv(der).value).forEach((integer, index) => {
    let bytes = integer.value;
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.subarray(1);
    out.set(bytes, index * size + size - bytes.length);
  });
  return out;
}

export async function publicKey(cert) {
  if (!cert.curve) throw new Error("x509: unsupported key");
  return crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: cert.curve[0] }, false, ["verify"]);
}

/// Checks that each certificate is signed by the next and the last by `root`, and that
/// all are valid at `at` (ms). The root may also be the last element. Returns parsed certs, leaf first.
export async function verifyChain(ders, rootDer, at) {
  const root = certificate(rootDer);
  let chain = ders.map(certificate);
  if (chain.length && equal(chain[chain.length - 1].der, rootDer)) chain = chain.slice(0, -1);
  if (!chain.length) throw new Error("x509: empty chain");
  for (let index = 0; index < chain.length; index++) {
    const cert = chain[index];
    const issuer = chain[index + 1] || root;
    if (!equal(cert.issuer, issuer.subject)) throw new Error(`x509: issuer mismatch at ${index}`);
    if (!(cert.notBefore <= at && at <= cert.notAfter)) throw new Error(`x509: not valid at ${index}`);
    if (!cert.hash) throw new Error(`x509: unsupported signature at ${index}`);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: cert.hash },
      await publicKey(issuer),
      rawSignature(cert.signature, issuer.curve[1]),
      cert.tbs
    );
    if (!ok) throw new Error(`x509: bad signature at ${index}`);
  }
  return chain;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
