# WakeUp — 버스 하차 알림 iOS 앱 개발 계획

## 1. 목표
- 시내버스 탑승 중 **목적지 정류장 1~2정거장 전**에 하차 알림.
- 시간 기반이 아닌 **GPS 기반** 판정.
- 배터리 절약: 트립이 활성일 때만 위치 수집, **도착(또는 종료 조건) 시 위치 수집 자동 중단**.

## 2. 핵심 사용자 흐름
1. 노선 검색 → 탑승 정류장 · 목적지 정류장 선택 (또는 즐겨찾기 선택)
2. 알림 시점 선택: 1정거장 전 / 2정거장 전 (기본 1)
3. "출발" → 트립 시작, 위치 추적 시작
4. 알림 정류장 통과/접근 시 로컬 알림 + 진동 (잠금화면 포함)
5. 목적지 도착 판정 → 추적 자동 종료, 트립 기록 저장

## 3. 기술 스택
| 항목 | 선택 |
|---|---|
| 최소 버전 | iOS 17 (`CLLocationUpdate.liveUpdates`, `CLBackgroundActivitySession`, `CLMonitor` 사용) |
| UI | SwiftUI |
| 상태/동시성 | Swift Concurrency, `@Observable` |
| 저장 | SwiftData (즐겨찾기, 최근 트립, 노선/정류장 캐시) |
| 알림 | `UserNotifications` (Time Sensitive), 선택적으로 Live Activity |
| 지도 | MapKit (정류장·노선 표시) |

## 4. 데이터 소스
- **국토교통부 TAGO API** (공공데이터포털): 노선 검색, 노선별 경유 정류소 목록(순번·좌표), 정류소 정보.
- 서울은 **서울시 버스정보 API** 병행 검토 (TAGO 서울 커버리지 확인 필요).
- 필요한 최소 데이터: `노선ID`, 정류장 `순번(seq)`, `이름`, `위도/경도`.
- 개인 사용 앱이므로 API 키는 `Secrets.xcconfig`(gitignore)에 두고 앱에 포함. 프록시 서버 불필요.
- 조회한 노선의 정류장 목록은 로컬 캐시 → 트립 중에는 **네트워크 불필요**.

### 4.1 노선/정류장 데이터 자동 갱신
노선 변경(경유지 추가·삭제, 정류장 이전·폐지)에 사람 개입 없이 대응한다.

**저장 원칙**
- 즐겨찾기·트립은 `순번(seq)`이 아닌 **정류장 ID(nodeid) + 노선ID**로 참조. 순번·좌표는 매번 최신 목록에서 다시 계산.
- 노선별 캐시에 `fetchedAt`, 정류장 목록 해시(`contentHash`) 저장.

**갱신 시점**
| 시점 | 동작 |
|---|---|
| 트립 시작 직전 | 네트워크 있으면 해당 노선 최신 목록 조회(타임아웃 3초). 실패 시 캐시로 진행 |
| 앱 실행 / 포그라운드 진입 | `fetchedAt`이 7일 지난 노선 백그라운드 갱신 |
| `BGAppRefreshTask` (하루 1회 요청) | 즐겨찾기 노선 전체 갱신 |

**변경 감지 및 자동 반영** (새 해시 ≠ 기존 해시일 때)
- 탑승/목적지 정류장 ID가 새 목록에 존재 → 순번·좌표·폴리라인 자동 갱신, 사용자 알림 없음.
- 정류장 ID가 사라짐 → 같은 이름 또는 200m 이내 정류장을 후보로 자동 매칭, 한 번 확인 요청. 후보 없으면 즐겨찾기를 "확인 필요"로 표시.
- 노선 자체가 폐선/조회 불가 → 즐겨찾기 비활성화 표시.

**안전장치**
- 캐시가 30일 이상 갱신 실패 시 트립 시작 화면에 경고 표시.
- API 응답 검증(정류장 0개, 좌표 범위 이상, 순번 누락)에 실패하면 기존 캐시 유지.

## 5. 위치 추적 전략 (배터리 핵심)
트립 상태에 따라 정밀도를 단계적으로 조절한다.

| 단계 | 조건 | 방식 | 정밀도 |
|---|---|---|---|
| Idle | 트립 없음 | 위치 수집 없음 | - |
| Far | 알림 정류장까지 남은 거리 > 2km | `liveUpdates(.otherNavigation)` + 큰 distanceFilter, 또는 Significant Location Change | 낮음 (~100m~1km) |
| Near | 남은 거리 ≤ 2km | `liveUpdates` 고정밀 | 높음 (~10m) |
| Done | 도착/종료 조건 | 모든 위치 업데이트·모니터 해제, `CLBackgroundActivitySession.invalidate()` | - |

- 백그라운드 유지: Background Modes → *Location updates*, 트립 시작을 포그라운드에서 하고 `CLBackgroundActivitySession` 생성 → **"When In Use" 권한만으로** 백그라운드 추적 가능.
- 보조 안전장치: 알림 정류장/목적지에 `CLMonitor` 원형 지오펜스 등록 (앱이 종료돼도 재실행). "Always" 권한이 있을 때만 활성화하는 옵션.
- 위치 업데이트 실패/중단 대비: 앱 재실행 시 진행 중 트립 복원.

## 6. 정류장 통과 판정 알고리즘
단순 반경 진입만 쓰면 도심 GPS 오차·짧은 정류장 간격(200~500m)에서 오판이 생기므로 **노선 위 진행도 기반**으로 판정한다.

1. 노선 정류장을 순서대로 이은 폴리라인 구성 (각 정류장의 누적거리 `d_i` 계산).
2. 위치 수신마다 현재 위치를 폴리라인에 투영 → 누적 진행거리 `p`.
   - `horizontalAccuracy` > 100m 인 샘플은 무시.
   - `p`는 단조 증가만 허용(작은 역행은 무시), 이상 점프 필터링.
3. 알림 정류장 `k = 목적지 seq - N` (N=1 또는 2).
   - `p ≥ d_k - 여유거리(예: 50m)` 이면 알림 발송 (1회만).
   - 정류장 간격이 매우 짧으면 `d_dest - p ≤ 최소거리(예: 400m)` 조건도 OR로 적용.
4. 도착 판정: `p ≥ d_dest - 30m` 또는 목적지 반경 50m 진입 → Done.
5. 노선 이탈 감지: 폴리라인과의 거리 > 300m 가 일정 시간 지속 → 사용자에게 확인 알림.

## 7. 자동 종료 조건 (위치 수집 중단)
- 목적지 도착 판정
- 사용자가 알림에서 "하차했어요" / "종료" 액션 선택
- 알림 후 목적지 통과(진행거리 초과) 감지
- 최대 트립 시간 초과 (예상 소요 × 2, 상한 3시간)
- 노선 이탈 확인 알림에 응답 없이 일정 시간 경과

종료 시: `liveUpdates` 루프 취소, `CLMonitor` 조건 제거, 백그라운드 세션 해제, Live Activity 종료.

## 8. 알림
- 권한: 알림 + Time Sensitive (Focus 모드 통과).
- 내용: "다음 정류장 ○○ — 2정거장 뒤 하차" + 액션 버튼(종료 / 다시 알림).
- 진동 강조: 포그라운드일 땐 Core Haptics로 반복 진동.
- Critical Alert는 Apple 승인이 필요하므로 MVP 제외.
- (선택) Live Activity / Dynamic Island 로 남은 정류장 수 표시.

## 9. 아키텍처
```
WakeUp/
├── App/                 # 엔트리, DI
├── Features/
│   ├── RouteSearch/     # 노선·정류장 검색/선택
│   ├── Trip/            # 진행 화면, 상태 표시
│   └── Favorites/
├── Core/
│   ├── Location/        # LocationTracker (liveUpdates, 정밀도 단계 전환)
│   ├── TripEngine/      # 진행도 계산, 알림/도착 판정 (순수 로직, 단위 테스트 대상)
│   ├── Notifications/   # NotificationService
│   └── Geofence/        # CLMonitor 래퍼
├── Data/
│   ├── API/             # TAGO 클라이언트
│   └── Persistence/     # SwiftData 모델
└── Tests/
```
- `TripEngine`은 위치 소스와 분리된 순수 상태머신 (`Idle → Tracking(Far/Near) → Alerted → Done`) → 기록된 GPS 트레이스로 재생 테스트.

## 10. 권한 / Info.plist
- `NSLocationWhenInUseUsageDescription`
- `NSLocationAlwaysAndWhenInUseUsageDescription` (선택 기능용)
- `UIBackgroundModes`: `location`
- 알림 권한은 첫 트립 시작 시 요청.

## 11. 마일스톤
| # | 범위 | 산출물 |
|---|---|---|
| M0 | 프로젝트 셋업 | Xcode 프로젝트, SwiftLint, CI(빌드·테스트) |
| M1 | 데이터 | TAGO 클라이언트, 노선/정류장 검색 UI, 캐시, 자동 갱신(4.1) |
| M2 | TripEngine | 진행도 계산·판정 로직 + GPX 트레이스 기반 단위 테스트 |
| M3 | 위치 추적 | LocationTracker, 정밀도 단계 전환, 백그라운드 세션, 자동 종료 |
| M4 | 알림 | 로컬 알림, 액션, 햅틱 |
| M5 | 보강 | CLMonitor 지오펜스, 트립 복원, 노선 이탈 감지 |
| M6 | 마감 | 즐겨찾기, Live Activity, 실제 버스 필드 테스트, 개인 기기 배포(14) |

## 12. 테스트 계획
- 단위: TripEngine에 실제/합성 GPS 트레이스 주입 (정상, GPS 튐, 짧은 정류장 간격, 노선 이탈, 신호 끊김).
- 시뮬레이터: GPX 파일로 경로 재생.
- 실기기: 여러 노선 실제 탑승, 배터리 소모 측정 (Xcode Energy Log / MetricKit).
- 목표: 30분 트립 기준 배터리 소모 ≤ 3~5%, 알림 누락 0.

## 13. 리스크
| 리스크 | 대응 |
|---|---|
| 지하차도·고층빌딩 GPS 오차 | 정확도 필터, 진행도 단조 증가, 거리 조건 OR |
| 앱 강제 종료 시 추적 중단 | CLMonitor 지오펜스 백업(Always 권한), 시작 시 안내 |
| 공공 API 장애/커버리지 | 정류장 데이터 캐시, 지역별 API 어댑터 |
| 정류장 좌표가 실제와 다름 | 여유거리 파라미터화, 필드 테스트로 튜닝 |
| 노선 개편으로 데이터 변경 | 4.1 자동 갱신·변경 감지 |

## 14. 배포 (App Store 없이 개인 기기 설치)
| 방식 | 비용 | 유효기간 | 비고 |
|---|---|---|---|
| 무료 Apple ID + Xcode 직접 설치 | 무료 | **7일** (만료 시 Xcode로 재설치) | 앱 3개 제한. 사용 기능(백그라운드 위치, 로컬 알림)은 모두 가능 |
| Apple Developer Program + Xcode 직접 설치 | 연 $99 | 1년 | 재설치 부담 거의 없음 |
| Developer Program + TestFlight | 연 $99 | 빌드당 90일 | 케이블 없이 설치·업데이트 |

**설치 절차 (무료 기준)**
1. Mac에 Xcode 설치 → Settings > Accounts에 Apple ID 추가.
2. 프로젝트 Signing & Capabilities에서 Team = Personal Team, Bundle ID를 고유값으로 변경.
3. iPhone을 케이블로 연결 → iPhone 설정 > 개인정보 보호 및 보안 > **개발자 모드** 켜기.
4. Xcode에서 기기 선택 후 Run.
5. iPhone 설정 > 일반 > VPN 및 기기 관리에서 개발자 앱 신뢰.

- 권장: 무료로 시작, 7일 재설치가 번거로우면 Developer Program 가입.
- Time Sensitive 알림·Live Activity는 무료 계정에서 동작 여부를 M0에서 확인.
