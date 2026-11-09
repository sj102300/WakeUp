const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const $toast = document.getElementById("toast");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(msg, ms = 3000) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), ms);
}

class Unauthorized extends Error {}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const isStandalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

function getPosition(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("위치 기능을 쓸 수 없습니다"));
    let best = null;
    const done = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      best ? resolve(best) : reject(new Error("위치를 가져오지 못했습니다"));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (p.coords.accuracy <= 100) done();
      },
      (e) => {
        if (e.code === e.PERMISSION_DENIED) {
          navigator.geolocation.clearWatch(id);
          clearTimeout(timer);
          reject(new Error("위치 권한이 거부되었습니다"));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    const timer = setTimeout(done, timeoutMs);
  });
}

// ---------- 푸시 ----------

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function ensurePush({ ask } = { ask: false }) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") {
    if (!ask) return "default";
    if ((await Notification.requestPermission()) !== "granted") return "denied";
  }
  const { publicKey } = await api("/api/push/key");
  if (!publicKey) throw new Error("서버에 푸시 키가 설정되지 않았습니다");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
  return "granted";
}

// ---------- 화면 ----------

const state = { view: "home", search: null, pollTimer: null, gpsWatch: null };

function setView(view, data) {
  state.view = view;
  clearInterval(state.pollTimer);
  for (const b of $nav.querySelectorAll("button")) b.classList.toggle("on", b.dataset.go === view);
  views[view](data).catch(handleError);
}

function handleError(e) {
  if (e instanceof Unauthorized) return views.login();
  console.error(e);
  toast(e.message || String(e), 5000);
}

$nav.addEventListener("click", (e) => {
  const go = e.target.closest("button")?.dataset.go;
  if (go) setView(go);
});

const views = {
  async login() {
    $nav.hidden = true;
    $app.innerHTML = `
      <div class="card">
        <h2>접속 토큰</h2>
        <p class="muted">Cloudflare에 설정한 APP_ACCESS_TOKEN을 입력하세요.</p>
        <input id="token" type="password" autocomplete="current-password" />
        <button class="primary" id="login">로그인</button>
      </div>`;
    $app.querySelector("#login").onclick = async () => {
      try {
        await api("/api/login", { method: "POST", body: { token: $app.querySelector("#token").value } });
        $nav.hidden = false;
        window.addEventListener("error", (e) => toast(`오류: ${e.message}`, 6000));
window.addEventListener("unhandledrejection", (e) => handleError(e.reason));

setView("home");
      } catch (e) {
        handleError(e);
      }
    };
  },

  async home() {
    $nav.hidden = false;
    const [trip, favorites, push] = await Promise.all([api("/api/trip"), api("/api/favorites"), pushState()]);
    $app.innerHTML = `
      ${push.html}
      ${trip ? tripCard(trip) : ""}
      <h2>즐겨찾기</h2>
      ${
        favorites.length
          ? `<ul class="list">${favorites
              .map(
                (f) => `<li class="pick" data-fav="${esc(f.id)}">
                  <div class="grow"><b>${esc(f.route.no)}</b> <span class="tag">${esc(f.route.region)}</span><br/>
                  <span class="muted">${esc(f.board.name)} → ${esc(f.dest.name)} · ${f.alertBefore}정거장 전</span></div>
                  <button class="tag" data-del="${esc(f.id)}">삭제</button></li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">아직 없어요.</p>`
      }
      <button class="primary" id="newRoute">+ 새 경로</button>`;
    $app.querySelector("#newRoute").onclick = () => setView("search");
    push.bind?.();
    if (trip) bindTrip(trip);
    for (const li of $app.querySelectorAll("[data-fav]")) {
      li.onclick = async (e) => {
        const del = e.target.closest("[data-del]");
        try {
          if (del) {
            await api(`/api/favorites/${del.dataset.del}`, { method: "DELETE" });
            return views.home();
          }
          await useFavorite(favorites.find((f) => f.id === li.dataset.fav));
        } catch (err) {
          handleError(err);
        }
      };
    }
  },

  async search() {
    $app.innerHTML = `
      <form class="card" id="searchForm">
        <label class="muted" for="q">노선 번호</label>
        <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="예: 9407" />
        <select id="region" style="margin-top:8px">
          <option value="">서울·경기</option>
        </select>
        <button class="primary" type="submit">검색</button>
      </form>
      <div id="results"></div>`;
    const $form = $app.querySelector("#searchForm");
    const $region = $app.querySelector("#region");
    // 도시 목록은 검색을 막지 않도록 나중에 채운다
    api("/api/regions")
      .then((regions) => $region.insertAdjacentHTML("beforeend", regions.map((r) => `<option value="${esc(r.code)}">${esc(r.name)}</option>`).join("")))
      .catch(() => {});
    $form.addEventListener("submit", (e) => {
      e.preventDefault();
      $app.querySelector("#q").blur();
      run().catch(handleError);
    });
    const run = async () => {
      const q = $app.querySelector("#q").value.trim();
      const $r = $app.querySelector("#results");
      if (!q) return toast("노선 번호를 입력하세요");
      $r.innerHTML = `<p class="muted">검색 중…</p>`;
      const { routes, errors } = await api(`/api/routes?q=${encodeURIComponent(q)}&region=${encodeURIComponent($region.value)}`);
      $r.innerHTML = `
        ${errors.length ? `<p class="warn">일부 지역 검색 실패: ${esc(errors.join(", "))}</p>` : ""}
        ${routes.length ? "" : `<p class="muted">결과가 없어요</p>`}
        <ul class="list">${routes
          .map(
            (r, i) => `<li class="pick" data-i="${i}"><div class="grow"><b>${esc(r.no)}</b> <span class="tag">${esc(r.region)}</span><br/>
            <span class="muted">${esc(r.start)} ↔ ${esc(r.end)}</span></div></li>`,
          )
          .join("")}</ul>`;
      for (const li of $r.querySelectorAll("[data-i]")) li.onclick = () => setView("stops", { route: routes[li.dataset.i] });
    };
  },

  async stops({ route, boardStopId, destStopId, alertBefore = 1 }) {
    $app.innerHTML = `<p class="muted">정류장 불러오는 중…</p>`;
    const { stops, stale } = await api(`/api/routes/${encodeURIComponent(route.key)}/stops`);
    let board = stops.find((s) => s.id === boardStopId);
    let dest = stops.find((s) => s.id === destStopId);
    let n = alertBefore;
    const render = () => {
      const hint = !board ? "탑승 정류장을 고르세요" : !dest ? "목적지 정류장을 고르세요" : "";
      $app.innerHTML = `
        <div class="card">
          <b>${esc(route.no)}</b> <span class="tag">${esc(route.region)}</span>
          <div class="muted">${esc(route.start)} ↔ ${esc(route.end)}</div>
          ${stale ? `<p class="warn">노선 정보 갱신 실패 — 저장된 정보 사용 중</p>` : ""}
          <p>${board ? `탑승 <b>${esc(board.name)}</b>` : ""}${dest ? ` → 하차 <b>${esc(dest.name)}</b>` : ""}</p>
          ${hint ? `<p class="muted">${hint}</p>` : ""}
          ${
            board && dest
              ? `<div class="muted">몇 정거장 전에 알릴까요?</div>
                 <div class="seg">${[1, 2, 3].map((k) => `<button data-n="${k}" class="${k === n ? "on" : ""}">${k}정거장 전</button>`).join("")}</div>
                 <button class="primary" id="board">탑승했어요</button>
                 <button class="secondary" id="save">즐겨찾기 저장</button>`
              : ""
          }
          ${board ? `<button class="danger" id="reset">다시 고르기</button>` : ""}
        </div>
        <ul class="list">${stops
          .map(
            (s) => `<li class="pick ${board?.id === s.id ? "sel-board" : ""} ${dest?.id === s.id ? "sel-dest" : ""}" data-id="${esc(s.id)}">
            <span class="grow">${esc(s.name)}</span><span class="muted">${s.order}</span></li>`,
          )
          .join("")}</ul>`;
      for (const li of $app.querySelectorAll("[data-id]")) {
        li.onclick = () => {
          const s = stops.find((x) => x.id === li.dataset.id);
          if (!board) board = s;
          else if (!dest && s.order > board.order) dest = s;
          else if (!dest) toast("목적지는 탑승 정류장보다 뒤여야 해요");
          render();
          window.scrollTo({ top: 0, behavior: "smooth" });
        };
      }
      for (const b of $app.querySelectorAll("[data-n]")) b.onclick = () => ((n = Number(b.dataset.n)), render());
      $app.querySelector("#reset")?.addEventListener("click", () => ((board = dest = undefined), render()));
      $app.querySelector("#save")?.addEventListener("click", () =>
        api("/api/favorites", { method: "POST", body: { route, boardStopId: board.id, destStopId: dest.id, alertBefore: n } })
          .then(() => toast("저장했어요"))
          .catch(handleError),
      );
      $app.querySelector("#board")?.addEventListener("click", () =>
        setView("identify", { route, board, dest, alertBefore: n }),
      );
    };
    render();
  },

  async identify({ route, board, dest, alertBefore }) {
    $app.innerHTML = `<div class="card"><p>내 위치 확인 중…</p><p class="muted">버스 안에서 잠시 기다려 주세요</p></div>`;
    let pos = null;
    try {
      pos = await getPosition();
    } catch (e) {
      toast(`${e.message} — 정류장 기준으로 찾습니다`);
    }
    const q = new URLSearchParams({ board: board.id });
    if (pos) (q.set("lat", pos.coords.latitude), q.set("lng", pos.coords.longitude));
    const list = await api(`/api/routes/${encodeURIComponent(route.key)}/vehicles?${q}`);
    const matched = list.filter((v) => v.matched);
    const start = async (vehicleNo) => {
      const push = await ensurePush({ ask: true }).catch(() => "error");
      const r = await api("/api/trip", { method: "POST", body: { route, boardStopId: board.id, destStopId: dest.id, alertBefore, vehicleNo } });
      if (push !== "granted" || !r.push?.ok) toast("알림 설정을 확인하세요 — 추적은 시작했어요", 5000);
      window.addEventListener("error", (e) => toast(`오류: ${e.message}`, 6000));
window.addEventListener("unhandledrejection", (e) => handleError(e.reason));

setView("home");
    };
    if (matched.length === 1) return start(matched[0].vehicleNo);
    $app.innerHTML = `
      <div class="card">
        <h2>탄 버스를 고르세요</h2>
        <p class="muted">${matched.length ? "가까운 버스가 여러 대예요." : "가까운 버스를 찾지 못했어요."} 버스 안에 표시된 차량번호를 확인하세요.</p>
      </div>
      <ul class="list">${list
        .map(
          (v) => `<li class="pick" data-v="${esc(v.vehicleNo)}"><div class="grow"><b>${esc(v.vehicleNo)}</b>
          ${v.matched ? `<span class="tag">근처</span>` : ""}<br/>
          <span class="muted">${esc(v.stopName)}${v.distanceM !== undefined ? ` · ${v.distanceM}m` : ""}</span></div></li>`,
        )
        .join("")}</ul>
      ${list.length ? "" : `<p class="muted">운행 중인 버스가 없어요</p>`}
      <button class="secondary" id="retry">다시 찾기</button>`;
    for (const li of $app.querySelectorAll("[data-v]")) li.onclick = () => start(li.dataset.v).catch(handleError);
    $app.querySelector("#retry").onclick = () => setView("identify", { route, board, dest, alertBefore });
  },

  async history() {
    const list = await api("/api/history");
    const reasons = { arrived: "도착", lost: "추적 끊김", timeout: "시간 초과", cancelled: "직접 종료" };
    $app.innerHTML = `
      <h2>최근 트립</h2>
      ${list.length ? "" : `<p class="muted">기록이 없어요</p>`}
      <ul class="list">${list
        .map(
          (t) => `<li><div class="grow"><b>${esc(t.routeNo)}</b> ${esc(t.board)} → ${esc(t.dest)}<br/>
          <span class="muted">${new Date(t.startedAt).toLocaleString("ko-KR")} · ${reasons[t.reason] ?? esc(t.reason)}</span></div>
          <button class="tag" data-log="${esc(t.id)}">기록 받기</button></li>`,
        )
        .join("")}</ul>
      <button class="danger" id="logout">로그아웃</button>`;
    for (const b of $app.querySelectorAll("[data-log]")) {
      b.onclick = async () => {
        const data = await api(`/api/history/${b.dataset.log}`);
        const file = new File([JSON.stringify(data, null, 2)], `wakeup-trip-${b.dataset.log}.json`, { type: "application/json" });
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] }).catch(() => {});
        else {
          const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
          a.click();
        }
      };
    }
    $app.querySelector("#logout").onclick = () => api("/api/logout", { method: "POST" }).then(views.login).catch(handleError);
  },
};

async function pushState() {
  if (!isStandalone()) {
    return {
      html: `<div class="card"><b>홈 화면에 추가하세요</b>
        <p class="muted">iPhone은 홈 화면 앱에서만 알림을 받을 수 있어요. Safari 공유 버튼 → "홈 화면에 추가" 후 그 아이콘으로 여세요.</p></div>`,
    };
  }
  const s = await ensurePush().catch(() => "error");
  if (s === "granted") return { html: "" };
  return {
    html: `<div class="card"><b>알림 허용이 필요해요</b>
      <p class="muted">${s === "denied" ? "설정 → 알림 → WakeUp에서 허용하세요." : "하차 알림을 받으려면 허용하세요."}</p>
      ${s === "denied" ? "" : `<button class="primary" id="enablePush">알림 허용</button>`}
      </div>`,
    bind: () =>
      $app.querySelector("#enablePush")?.addEventListener("click", async () => {
        const r = await ensurePush({ ask: true }).catch(handleError);
        if (r === "granted") {
          await api("/api/push/test", { method: "POST" }).catch(() => {});
          views.home();
        }
      }),
  };
}

function tripCard(t) {
  const phase = { tracking: "추적 중", alerted: "곧 하차" }[t.phase] ?? t.phase;
  const ago = t.lastObs ? Math.round((Date.now() - t.lastObs.at) / 1000) : null;
  const recording = state.gpsWatch !== null;
  return `
    <div class="card">
      <div class="row"><div class="grow"><b>${esc(t.route.no)}</b> · ${esc(t.vehicleNo)}</div><span class="tag">${phase}</span></div>
      <div class="big ${t.phase === "alerted" ? "warn" : ""}">${t.stopsLeft}정거장 남음</div>
      <div class="muted">${esc(t.board.name)} → ${esc(t.dest.name)} · ${t.alertBefore}정거장 전 알림</div>
      <div class="muted">${ago === null ? "버스 위치 확인 중…" : `마지막 위치 ${ago}초 전`}</div>
      <button class="secondary" id="gps">${recording ? "GPS 기록 끄기" : "GPS 기록 켜기 (실측용, 화면 켜둠)"}</button>
      <button class="danger" id="stop">추적 종료</button>
    </div>`;
}

function bindTrip(t) {
  $app.querySelector("#stop").onclick = async () => {
    if (!confirm("추적을 끝낼까요?")) return;
    stopGps();
    await api("/api/trip", { method: "DELETE" }).catch(handleError);
    views.home();
  };
  $app.querySelector("#gps").onclick = () => {
    state.gpsWatch === null ? startGps() : stopGps();
    views.home();
  };
  state.pollTimer = setInterval(() => state.view === "home" && views.home().catch(handleError), 10000);
}

function startGps() {
  let last = 0;
  state.gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      api("/api/trip/gps", {
        method: "POST",
        body: { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy },
      }).catch(() => {});
    },
    () => {},
    { enableHighAccuracy: true },
  );
}

function stopGps() {
  if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
}

async function useFavorite(f) {
  const r = await api(`/api/favorites/${f.id}/resolve`);
  const pick = (m, saved) => (m.kind === "same" ? m.stop.id : undefined);
  const notes = [];
  for (const [label, m, saved] of [["탑승", r.board, f.board], ["하차", r.dest, f.dest]]) {
    if (m.kind === "moved") notes.push(`${label} 정류장 "${saved.name}" → "${m.stop.name}" (${m.distanceM}m)`);
    if (m.kind === "missing") notes.push(`${label} 정류장 "${saved.name}"이 노선에서 사라졌어요`);
  }
  if (notes.length) {
    const ok = confirm(`노선 정보가 바뀌었어요.\n${notes.join("\n")}\n\n바뀐 정류장으로 진행할까요? (취소하면 직접 고릅니다)`);
    const id = (m) => (m.kind === "missing" ? undefined : m.stop.id);
    return setView("stops", {
      route: f.route,
      boardStopId: ok ? id(r.board) : pick(r.board),
      destStopId: ok ? id(r.dest) : pick(r.dest),
      alertBefore: f.alertBefore,
    });
  }
  setView("stops", { route: f.route, boardStopId: r.board.stop.id, destStopId: r.dest.stop.id, alertBefore: f.alertBefore });
}

window.addEventListener("error", (e) => toast(`오류: ${e.message}`, 6000));
window.addEventListener("unhandledrejection", (e) => handleError(e.reason));

setView("home");
