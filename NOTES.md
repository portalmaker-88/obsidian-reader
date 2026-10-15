# 작업 인계 메모 (2026-10-12)

새 세션의 Claude는 이 파일, README.md, 설정-가이드.md를 먼저 읽을 것.

## 목표
Even G2 안경에서 Obsidian 보관함(md)을 폴더별로 탐색하고 읽기. 보관함은 PC에서 OneDrive로 동기화 중이며,
그대로 두고 Obsidian Git 플러그인으로 GitHub 비공개 저장소(portalmaker-88/obsidian-vault)에 추가 백업 → 앱이 GitHub API로 읽는 구조(사용자 선택 A안).
OneDrive 직접 연결(B안)은 MS 로그인이 Even 앱 WebView에서 되는지 불확실 + SPA 토큰 24시간 만료 문제로 보류.

## 상태
- 구현 완료, `tsc`·`vite build` 통과.
- Node(tsx) 실측: obsidianmd/obsidian-help(en) 보관함으로 목록 179개, 폴더 목록, 검색, 노트 raw 읽기, md 변환, 페이지 분할(143페이지 최대 8줄, 넘침 0), 404 오류 메시지 확인.
- api.github.com CORS: Access-Control-Allow-Origin *, preflight에서 Authorization 허용 확인.
- **미검증:** 실제 안경/시뮬레이터 화면(시뮬레이터가 이 PC에서 exit 1), 특히 list 컨테이너 탭 이벤트(listEvent)와 rebuildPageContainer 전환.
- 로컬 git 첫 커밋까지 완료. GitHub 저장소 생성/push/Pages 설정은 사용자가 진행 예정(설정-가이드.md 4단계).

## 결정 사항
- 레이아웃 2개: list(헤더 + 펌웨어 리스트, 20개/64자 제한 → 18개씩 페이지 + ▲▼), reader(투명 입력 레이어 + 줄 컨테이너 6개(40px 간격, 1.5배 줄 간격) + 상태줄 = 텍스트 컨테이너 8개, 최대치).
- createStartUpPageContainer는 호스트 세션당 한 번만 동작(재실행 시 무시될 수 있음) → 시작하자마자 boot()로 임시 화면, 실제 화면은 항상 rebuildPageContainer. FOREGROUND_ENTER에서 redraw. 줄 단위 textContainerUpgrade로 바뀐 줄만 갱신.
- reading.open: 노트를 보던 중 종료/백그라운드되면 다음 실행 때 그 노트를 다시 엶.
- v0.1.1(2026-10-13): 사용자 보고 2건 수정 — 줄 간격 1.5배, 두 번째 실행부터 안경에 안 뜨는 문제(원인 추정: createStartUp 무시 + 저장소 읽기 후 첫 화면 생성).
- 모든 bridge 호출은 src/bridge.ts `serial()`로 직렬화(10초 타임아웃). serial 안에서 serial 호출 금지(교착).
- 노트 캐시: blob sha 키, 최근 10개, 30만 자 이하. 노트 목록도 캐시 후 시작 시 백그라운드 갱신.
- 안경 글리프는 design-guidelines에 있는 것만 사용(■ ▶ ▷ □ │ ─ ★ ◀ ▲ ▼).
- package_id: com.portalmaker88.obsidianreader, network whitelist: https://api.github.com
- Windows: 경로가 길면 npm install/git 실패 → 프로젝트는 C:\Users\user\obsidian-reader. PowerShell에서는 npm.cmd/npx.cmd.

## v0.2.0 (2026-10-15) 구조 개편 — 사용자 보고: 목록 ▼다음 안 됨, 노트 오가며 멈춤, 한 번 탭이 더블탭처럼
- bridge.ts: 단일 체인 → 2레인 스케줄러(ui 우선, bg는 렌더 중 보류). 저장 쓰기가 화면을 막던 문제 제거.
- glasses.ts: show(screen) 선언형 렌더러. 최신 화면만 그림, 줄 갱신 사이마다 새 요청 확인(연타 합침), 업그레이드 실패 시 전체 rebuild, rebuild 중·직후 350ms 입력 무시(inputBlocked).
- main.ts: 입력 파싱 한곳(parseInput) + 메아리 제거(같은 입력 180ms, 더블 800ms, 더블 직후 500ms 모두 무시). 목록 선택은 펌웨어가 돌려주는 currentSelectItemName으로 찾고 index는 예비.
- 목록 페이지: 17개 + 상단칸 + ▲ + ▼ ≤ 20 (예전엔 하위 폴더 2쪽부터 21개가 될 수 있었음). ▲▼에 범위 표시, 노트에서 나오면 그 노트가 있는 쪽으로 복귀.
- 노트 열 때 화면 전환 없이 목록 헤더만 "여는 중"으로 바꿈, 세션 메모리 캐시 30개.
- 루트에서 종료 대화상자 취소 시 화면 다시 그림. 휴대폰 화면에 "진단 정보"(최근 입력 원본, 화면 오류) 추가.
- ▼다음이 안 된 정확한 원인은 실기기 로그 없이 확정 못 함(후보: index 불일치, 21개 초과, 입력 메아리). 다시 생기면 진단 정보 캡처 요청.

## v0.2.1 (2026-10-15) — 사용자 보고: 실행하면 안경에 "노트 목록을 불러오는 중"만 계속 뜸, 휴대폰에서 노트를 열면 그때부터 동작
- 추정 원인: rebuildPageContainer를 짧은 간격으로 연달아 보내면 안경이 뒤의 것을 (성공 응답과 함께) 버림. 시작 시 boot → 메시지(rebuild) → 목록(rebuild)이 연달아 나가 목록이 버려짐. 휴대폰에서 노트를 열면 메시지→노트가 같은 레이아웃이라 rebuild 없이 글자만 바뀌어 동작했던 것과 일치.
  매번 이 경로를 탄 건 목록 캐시가 없었기 때문(저장 실패 또는 저장 전 종료 추정).
- 수정: rebuild 간 최소 600ms 간격(그 사이 더 새 화면이 요청되면 옛 화면은 건너뜀). message를 별도 1컨테이너 레이아웃으로 분리하고 boot 화면을 message로 간주 → 시작 메시지는 rebuild 없이 글자만 갱신. 휴대폰에서 노트를 열 때 읽던 화면이면 상태줄로 "여는 중" 표시(rebuild 없음).
- 목록 캐시: 압축 형식(list2, 경로/sha 배열) + 청크 20k.
- 테스트 가짜 안경에 "400ms 안에 온 rebuild는 성공 응답 후 버림" 모델 추가. 이 모델에서 v0.2.0 코드는 시작 테스트가 실패(증상 재현), v0.2.1은 12개 모두 통과. 실제 안경의 정확한 동작은 미확인.

## 다음 할 일
1. 사용자: 설정-가이드.md 1~4단계.
2. 안경 실측 후 문제 수정(리스트 탭 인덱스, 한글 표시, 목록↔노트 전환 깜빡임).
3. 아이디어: [[링크]] 따라가기, 최근 노트 목록, 노트 내 소제목 점프.
