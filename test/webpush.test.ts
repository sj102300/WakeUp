import { describe, expect, it } from "vitest";
import { b64url, encryptPayload, unb64url, vapidAuthorization } from "../src/push/webpush";

const enc = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) (o.set(x, i), (i += x.length));
  return o;
};

describe("web push", () => {
  it("수신 측(브라우저) 방식으로 복호화하면 원문이 나온다", async () => {
    // 브라우저 역할의 키쌍과 auth 비밀값
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: "https://web.push.apple.com/x", keys: { p256dh: b64url(uaPublic), auth: b64url(auth) } };

    const body = await encryptPayload(sub, enc.encode('{"title":"하차"}'));

    const salt = body.slice(0, 16);
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    const asPublic = body.slice(21, 86);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, ua.privateKey, 256));
    const prkKey = await hmac(auth, secret);
    const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));

    expect(plain.at(-1)).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe('{"title":"하차"}');
  });

  it("VAPID JWT 서명이 공개키로 검증된다", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
    const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    const v = { publicKey: b64url(pub), privateKey: jwk.d!, subject: "mailto:test@example.com" };

    const h = await vapidAuthorization("https://web.push.apple.com/abc", v, 0);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(v.publicKey);
    expect(JSON.parse(new TextDecoder().decode(unb64url(m[2])))).toMatchObject({ aud: "https://web.push.apple.com", exp: 43200 });
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      unb64url(m[3]),
      enc.encode(`${m[1]}.${m[2]}`),
    );
    expect(ok).toBe(true);
  });
});
