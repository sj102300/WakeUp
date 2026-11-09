// 웹앱 파일을 Worker 번들에 포함해 제공한다 (wrangler rules: Text/Data).
// @ts-ignore 텍스트로 번들되는 JS
import appJs from "../web/app.js";
import icon180 from "../web/icon-180.png";
import icon192 from "../web/icon-192.png";
import icon512 from "../web/icon-512.png";
import indexHtml from "../web/index.html";
import manifest from "../web/manifest.webmanifest";
import styleCss from "../web/style.css";
// @ts-ignore 텍스트로 번들되는 JS
import swJs from "../web/sw.js";

const FILES: Record<string, { body: string | ArrayBuffer; type: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8" },
  "/sw.js": { body: swJs, type: "text/javascript; charset=utf-8" },
  "/style.css": { body: styleCss, type: "text/css; charset=utf-8" },
  "/manifest.webmanifest": { body: manifest, type: "application/manifest+json" },
  "/icon-180.png": { body: icon180, type: "image/png" },
  "/icon-192.png": { body: icon192, type: "image/png" },
  "/icon-512.png": { body: icon512, type: "image/png" },
};

export function serveStatic(path: string): Response | null {
  const f = FILES[path];
  if (!f) return null;
  return new Response(f.body, {
    headers: {
      "Content-Type": f.type,
      // 배포 즉시 반영되도록 캐시하지 않음 (파일이 작음)
      "Cache-Control": "no-cache",
    },
  });
}
