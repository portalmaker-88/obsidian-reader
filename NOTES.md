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
- 레이아웃 2개: list(헤더 텍스트 + 펌웨어 리스트, 항목 20개/64자 제한 → 18개씩 페이지 + ▲▼ 항목), reader(본문 576x250 + 상태줄).
- 첫 화면만 createStartUpPageContainer, 이후 레이아웃 전환은 rebuildPageContainer(텍스트 1000자 제한 → 넘으면 upgrade로 다시 씀), 페이지 넘김은 textContainerUpgrade.
- 모든 bridge 호출은 src/bridge.ts `serial()`로 직렬화(10초 타임아웃). serial 안에서 serial 호출 금지(교착).
- 노트 캐시: blob sha 키, 최근 10개, 30만 자 이하. 노트 목록도 캐시 후 시작 시 백그라운드 갱신.
- 안경 글리프는 design-guidelines에 있는 것만 사용(■ ▶ ▷ □ │ ─ ★ ◀ ▲ ▼).
- package_id: com.portalmaker88.obsidianreader, network whitelist: https://api.github.com
- Windows: 경로가 길면 npm install/git 실패 → 프로젝트는 C:\Users\user\obsidian-reader. PowerShell에서는 npm.cmd/npx.cmd.

## 다음 할 일
1. 사용자: 설정-가이드.md 1~4단계.
2. 안경 실측 후 문제 수정(리스트 탭 인덱스, 한글 표시, 목록↔노트 전환 깜빡임).
3. 아이디어: [[링크]] 따라가기, 최근 노트 목록, 노트 내 소제목 점프.
