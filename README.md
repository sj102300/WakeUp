# WakeUp

버스 하차 알림 웹앱. 내가 탄 버스의 실시간 위치(서울·경기·TAGO 공공 API)로 목적지 1~3정거장 전에 iPhone 잠금화면 푸시를 보낸다.

- 계획: [docs/PLAN.md](docs/PLAN.md)
- 서버: Cloudflare Workers + Durable Object (`src/`)
- 웹앱(PWA): `web/`

## 사용법 (iPhone)
1. Safari로 앱 주소 접속 → 공유 → **홈 화면에 추가**
2. 홈 화면 아이콘으로 열고 접속 토큰 입력 → 알림 허용
3. 새 경로 → 노선 검색 → 탑승·하차 정류장 선택 → 버스에 탄 뒤 **탑승했어요**
4. 앱을 닫아도 됨. 하차 N정거장 전 알림, 도착 시 자동 종료

## Cloudflare Secrets
| 이름 | 설정 주체 |
|---|---|
| `DATA_GO_KR_API_KEY` | 사용자 (공공데이터포털 일반 인증키, Decoding) |
| `SEOUL_BUS_API_KEY` | 사용자 (선택, 없으면 `DATA_GO_KR_API_KEY` 사용) |
| `APP_ACCESS_TOKEN` | 사용자 (앱 로그인 비밀번호, 직접 정한 긴 문자열) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `scripts/set-vapid.mjs` |

## 개발
```
npm install
npm test          # 단위 + Workers 런타임 통합 테스트
npm run typecheck
npm run deploy
```
