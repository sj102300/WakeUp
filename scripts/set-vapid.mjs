// VAPID 키쌍을 만들어 Worker Secrets에 바로 저장한다. 개인키는 화면·파일에 남기지 않는다.
// 사용: node scripts/set-vapid.mjs https://wakeup.<서브도메인>.workers.dev
import { spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

const subject = process.argv[2];
if (!subject?.startsWith("https://")) {
  console.error("usage: node scripts/set-vapid.mjs <https 앱 주소>");
  process.exit(1);
}

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", kp.privateKey);

// 공개키·개인키가 어긋나지 않도록 한 번에 저장
const input = JSON.stringify({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: subject });
const r = spawnSync("npx", ["wrangler", "secret", "bulk"], { input, stdio: ["pipe", "inherit", "inherit"] });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("VAPID secrets saved");
