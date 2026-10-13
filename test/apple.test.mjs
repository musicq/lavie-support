// Checks lib/apple.js against a made-up chain shaped like Apple's (openssl), since real
// attestations and transactions only come from a device. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAssertion, verifyAttestation, verifyTransaction, toBase64 } from "../lib/apple.js";

const APP_ID = "QASBQ2U5K7.app.lifebar";
const dir = mkdtempSync(join(tmpdir(), "lavie-apple-"));
const ssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
const der = (name) => new Uint8Array(ssl("x509", "-in", name, "-outform", "der"));
const sha = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const b64 = (bytes) => toBase64(bytes);
const b64url = (bytes) => b64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const join2 = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));

function key(name, curve) {
  ssl("ecparam", "-name", curve, "-genkey", "-noout", "-out", name);
}
function ca(name, signer, extra = []) {
  key(`${name}.key`, "secp384r1");
  if (!signer) return ssl("req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-days", "30", "-sha384", "-out", `${name}.pem`);
  ssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-out", `${name}.csr`);
  writeFileSync(join(dir, `${name}.ext`), ["basicConstraints=critical,CA:true", ...extra].join("\n"));
  ssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${signer}.pem`, "-CAkey", `${signer}.key`, "-CAcreateserial", "-days", "30", "-sha384", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
}
function leaf(name, signer, extensions) {
  key(`${name}.key`, "prime256v1");
  ssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-out", `${name}.csr`);
  writeFileSync(join(dir, `${name}.ext`), extensions.join("\n") || "basicConstraints=CA:false");
  ssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${signer}.pem`, "-CAkey", `${signer}.key`, "-CAcreateserial", "-days", "30", "-sha384", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
  // The uncompressed public point: the last 65 bytes of the DER SubjectPublicKeyInfo.
  const spki = new Uint8Array(ssl("ec", "-in", `${name}.key`, "-pubout", "-outform", "der"));
  return { point: spki.subarray(spki.length - 65), privateKey: createPrivateKey(readFileSync(join(dir, `${name}.key`))) };
}

// Tiny CBOR encoder for the test objects.
function cbor(value) {
  const head = (major, length) =>
    length < 24 ? [(major << 5) | length] : length < 256 ? [(major << 5) | 24, length] : [(major << 5) | 25, length >> 8, length & 255];
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value);
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}
const encode = (value) => Uint8Array.from(cbor(value));

ca("root");
ca("intermediate", "root");
const root = der("root.pem");

function authData({ counter = 0, aaguid = "appattestdevelop", credential, appId = APP_ID }) {
  const count = [counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255];
  const parts = [sha(new TextEncoder().encode(appId)), [0x40], count];
  if (credential) parts.push(new TextEncoder().encode(aaguid), [0, credential.length], credential);
  return join2(...parts);
}

function attestation(challenge, options = {}) {
  // The key id is the SHA-256 of the public point; the certificate carries the nonce.
  const probe = leaf("probe", "intermediate", []);
  const keyId = sha(probe.point);
  const data = authData({ credential: keyId, ...options });
  const nonce = sha(join2(data, sha(new TextEncoder().encode(options.signedChallenge ?? challenge))));
  const hex = Buffer.from(nonce).toString("hex");
  writeFileSync(join(dir, "credential.key"), readFileSync(join(dir, "probe.key")));
  ssl("req", "-new", "-key", "credential.key", "-subj", "/CN=credential", "-out", "credential.csr");
  writeFileSync(join(dir, "credential.ext"), `1.2.840.113635.100.8.2=DER:3024a1220420${hex}`);
  ssl("x509", "-req", "-in", "credential.csr", "-CA", "intermediate.pem", "-CAkey", "intermediate.key", "-CAcreateserial", "-days", "30", "-sha384", "-extfile", "credential.ext", "-out", "credential.pem");
  const object = { fmt: "apple-appattest", attStmt: { x5c: [der("credential.pem"), der("intermediate.pem")], receipt: new Uint8Array([1]) }, authData: data };
  return { keyId: b64(keyId), attestation: b64(encode(object)), privateKey: probe.privateKey };
}

test("App Attest: a well-formed attestation passes and its key verifies assertions", async () => {
  const made = attestation("challenge-1");
  const stored = await verifyAttestation({ keyId: made.keyId, attestation: made.attestation, challenge: "challenge-1", appId: APP_ID, root });
  assert.equal(stored.environment, "development");

  const clientData = new TextEncoder().encode('{"challenge":"c2","chunks":1}');
  const assertionFor = (counter, payload = clientData) => {
    const data = authData({ counter });
    const nonce = sha(join2(data, sha(payload)));
    const signature = new Uint8Array(sign("sha256", nonce, made.privateKey)); // DER, like the device
    return b64(encode({ signature, authenticatorData: data }));
  };
  const counter = await verifyAssertion({ assertion: assertionFor(1), clientData, publicKey: stored.publicKey, counter: 0, appId: APP_ID });
  assert.equal(counter, 1);
  await assert.rejects(verifyAssertion({ assertion: assertionFor(1), clientData, publicKey: stored.publicKey, counter: 1, appId: APP_ID }), /counter/);
  const other = new TextEncoder().encode('{"challenge":"c3","chunks":40}');
  await assert.rejects(verifyAssertion({ assertion: assertionFor(2), clientData: other, publicKey: stored.publicKey, counter: 1, appId: APP_ID }), /signature/);
});

test("App Attest: wrong challenge, app or key id is refused", async () => {
  const made = attestation("challenge-a");
  await assert.rejects(verifyAttestation({ keyId: made.keyId, attestation: made.attestation, challenge: "challenge-b", appId: APP_ID, root }), /nonce/);
  await assert.rejects(verifyAttestation({ keyId: made.keyId, attestation: made.attestation, challenge: "challenge-a", appId: "TEAM.other.app", root }), /app id/);
  const elsewhere = attestation("challenge-c");
  await assert.rejects(verifyAttestation({ keyId: elsewhere.keyId, attestation: made.attestation, challenge: "challenge-a", appId: APP_ID, root }), /key id/);
  // A chain that doesn't lead to the pinned root.
  await assert.rejects(verifyAttestation({ keyId: made.keyId, attestation: made.attestation, challenge: "challenge-a", appId: APP_ID }), /x509/);
});

test("StoreKit: a signed transaction passes; tampering, expiry and other apps are refused", async () => {
  const signer = leaf("storekit", "intermediate", []);
  const x5c = [der("storekit.pem"), der("intermediate.pem"), root].map(b64);
  const now = Date.now();
  const jws = (payload) => {
    const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", x5c })));
    const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: signer.privateKey, dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
  };
  const base = { bundleId: "app.lifebar", productId: "com.lifebar.pro.annual", originalTransactionId: "2000000123", expiresDate: now + 86_400_000, signedDate: now, environment: "Sandbox", offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 };
  const options = { bundleId: "app.lifebar", products: ["com.lifebar.pro.monthly", "com.lifebar.pro.annual"], root };

  const ok = await verifyTransaction(jws(base), options);
  assert.deepEqual(ok, { originalTransactionId: "2000000123", productId: "com.lifebar.pro.annual", environment: "Sandbox", trial: true });
  assert.equal((await verifyTransaction(jws({ ...base, offerType: undefined, offerDiscountType: undefined, price: 34990 }), options)).trial, false);

  const [head, , signature] = jws(base).split(".");
  const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...base, expiresDate: now + 9e12 })));
  await assert.rejects(verifyTransaction(`${head}.${forged}.${signature}`, options), /signature/);
  await assert.rejects(verifyTransaction(jws({ ...base, expiresDate: now - 1000 }), options), /expired/);
  await assert.rejects(verifyTransaction(jws({ ...base, bundleId: "com.other" }), options), /bundle/);
  await assert.rejects(verifyTransaction(jws({ ...base, environment: "Xcode" }), options), /environment/);
  await assert.rejects(verifyTransaction(jws(base), { ...options, root: undefined }), /x509/);
});
