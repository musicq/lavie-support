// Apple's three checks for /api: App Attest (the genuine app on a real device), StoreKit
// transactions (who has Lavie Plus) and DeviceCheck (whether this device used its free import).

import { decode } from "./cbor.js";
import { certificate, equal, items, publicKey, rawSignature, tlv, verifyChain } from "./der.js";

// Apple App Attestation Root CA, SHA-256 1C:B9:82:3B:…:62:42:C9:32
const APP_ATTEST_ROOT = base64("MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD");
// Apple Root CA - G3, SHA-256 63:34:3A:BF:…:65:3E:91:79
const APPLE_ROOT_G3 = base64("MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==");

const encoder = new TextEncoder();
export const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export function base64(text) {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "===".slice((normal.length + 3) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// MARK: App Attest

const AAGUID_PRODUCTION = encoder.encode("appattest\0\0\0\0\0\0\0");
const AAGUID_DEVELOPMENT = encoder.encode("appattestdevelop");

function authenticatorData(bytes) {
  return {
    rpIdHash: bytes.subarray(0, 32),
    counter: ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36],
    aaguid: bytes.subarray(37, 53),
    credentialId: bytes.length > 55 ? bytes.subarray(55, 55 + ((bytes[53] << 8) | bytes[54])) : null,
  };
}

/// Verifies a new key's attestation (Apple's steps 1–9). Returns the key to store.
export async function verifyAttestation({ keyId, attestation, challenge, appId, now = Date.now(), root = APP_ATTEST_ROOT }) {
  const object = decode(base64(attestation));
  if (object.fmt !== "apple-appattest") throw new Error("attest: format");
  const chain = await verifyChain(object.attStmt.x5c, root, now);
  const credential = chain[0];
  const data = object.authData;

  const nonce = await sha256(concat(data, await sha256(encoder.encode(challenge))));
  const extension = credential.extensions.get("1.2.840.113635.100.8.2");
  if (!extension) throw new Error("attest: no nonce");
  const tagged = items(tlv(extension).value)[0]; // SEQUENCE { [1] { OCTET STRING nonce } }
  if (!equal(tlv(tagged.value).value, nonce)) throw new Error("attest: nonce");

  const key = base64(keyId);
  if (!equal(await sha256(credential.point), key)) throw new Error("attest: key id");
  const parsed = authenticatorData(data);
  if (!equal(parsed.rpIdHash, await sha256(encoder.encode(appId)))) throw new Error("attest: app id");
  if (parsed.counter !== 0) throw new Error("attest: counter");
  const environment = equal(parsed.aaguid, AAGUID_PRODUCTION) ? "production" : equal(parsed.aaguid, AAGUID_DEVELOPMENT) ? "development" : null;
  if (!environment) throw new Error("attest: aaguid");
  if (!parsed.credentialId || !equal(parsed.credentialId, key)) throw new Error("attest: credential id");
  return { publicKey: toBase64(credential.spki), environment };
}

/// Verifies an assertion over `clientData` with a stored key. Returns the new counter.
export async function verifyAssertion({ assertion, clientData, publicKey: spki, counter, appId }) {
  const object = decode(base64(assertion));
  const data = object.authenticatorData;
  const nonce = await sha256(concat(data, await sha256(clientData)));
  const key = await crypto.subtle.importKey("spki", base64(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature(object.signature, 32), nonce);
  if (!ok) throw new Error("assert: signature");
  const parsed = authenticatorData(data);
  if (!equal(parsed.rpIdHash, await sha256(encoder.encode(appId)))) throw new Error("assert: app id");
  if (!(parsed.counter > counter)) throw new Error("assert: counter");
  return parsed.counter;
}

// MARK: StoreKit

/// Verifies a StoreKit 2 transaction JWS (`jwsRepresentation`) signed through Apple Root CA - G3.
export async function verifyTransaction(jws, { bundleId, products, now = Date.now(), root = APPLE_ROOT_G3 }) {
  const [head, body, signature] = jws.split(".");
  const header = JSON.parse(new TextDecoder().decode(base64(head)));
  const payload = JSON.parse(new TextDecoder().decode(base64(body)));
  if (header.alg !== "ES256" || !Array.isArray(header.x5c)) throw new Error("jws: header");
  // Apple's own libraries check the chain at the signing date, not today.
  const chain = await verifyChain(header.x5c.map(base64), root, payload.signedDate || now);
  if (root === APPLE_ROOT_G3) {
    if (!chain[0].extensions.has("1.2.840.113635.100.6.11.1")) throw new Error("jws: leaf oid");
    if (!chain[1]?.extensions.has("1.2.840.113635.100.6.2.1")) throw new Error("jws: intermediate oid");
  }
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(chain[0]), base64(signature), encoder.encode(`${head}.${body}`));
  if (!ok) throw new Error("jws: signature");
  if (payload.bundleId !== bundleId) throw new Error("jws: bundle");
  if (!products.includes(payload.productId)) throw new Error("jws: product");
  if (payload.revocationDate) throw new Error("jws: revoked");
  if (!(payload.expiresDate > now)) throw new Error("jws: expired");
  if (payload.environment !== "Production" && payload.environment !== "Sandbox") throw new Error("jws: environment");
  const trial = payload.offerDiscountType === "FREE_TRIAL" || (payload.offerType === 1 && !payload.price);
  return { originalTransactionId: String(payload.originalTransactionId), productId: payload.productId, environment: payload.environment, trial };
}

// MARK: DeviceCheck

async function deviceCheckToken(env) {
  const pem = env.DEVICECHECK_KEY.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", base64(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (value) => toBase64(encoder.encode(JSON.stringify(value))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${part({ alg: "ES256", kid: env.DEVICECHECK_KEY_ID })}.${part({ iss: env.APPLE_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)));
  return `${unsigned}.${toBase64(signature).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

async function deviceCheck(env, path, deviceToken, sandbox, extra = {}) {
  const host = sandbox ? "api.development.devicecheck.apple.com" : "api.devicecheck.apple.com";
  const response = await fetch(`https://${host}/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await deviceCheckToken(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ device_token: deviceToken, transaction_id: crypto.randomUUID(), timestamp: Date.now(), ...extra }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`devicecheck ${path}: ${response.status} ${text.slice(0, 80)}`);
  return text;
}

/// Whether this device has used its free import (bit 0).
export async function trialUsed(env, deviceToken, sandbox) {
  const text = await deviceCheck(env, "query_two_bits", deviceToken, sandbox);
  try {
    return JSON.parse(text).bit0 === true;
  } catch {
    return false; // "Failed to find bit state": never set
  }
}

export async function markTrialUsed(env, deviceToken, sandbox) {
  await deviceCheck(env, "update_two_bits", deviceToken, sandbox, { bit0: true, bit1: false });
}
