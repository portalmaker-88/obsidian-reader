# Obsidian 리더 (Even G2)

GitHub 저장소에 동기화된 Obsidian 보관함을 G2 안경에서 폴더별로 탐색하고 읽는 Even Hub 앱.
설정 방법은 [설정-가이드.md](설정-가이드.md) 참고.

## 동작 방식

```
PC Obsidian (보관함은 OneDrive 폴더)
  └─ Obsidian Git 플러그인 → 10분마다 GitHub 비공개 저장소(obsidian-vault)에 자동 백업
G2 앱 (GitHub Pages: obsidian-reader)
  └─ GitHub API로 노트 목록·내용을 읽음 (읽기 전용 토큰)
```

## 안경 조작

| 화면 | 동작 |
|---|---|
| 목록 | 위/아래 스와이프: 항목 이동 · 탭: 폴더 열기 / 노트 열기 · 더블탭: 상위 폴더 (최상위에서는 종료) |
| 노트 | 탭 또는 아래 스와이프: 다음 페이지 · 위 스와이프: 이전 페이지 · 더블탭: 목록으로 |

- 최상위 목록 맨 위의 **★ 이어 읽기**로 마지막 노트를 읽던 페이지부터 다시 연다.
- 한 폴더에 항목이 20개를 넘으면 **▲ 이전 목록 / ▼ 다음 목록**으로 넘긴다.
- 휴대폰 화면에서 노트 이름 검색 → 누르면 안경에 바로 열린다.

## 구성

| 파일 | 역할 |
|---|---|
| `src/main.ts` | 화면 전환(목록/노트), 안경 입력, 휴대폰 UI |
| `src/github.ts` | GitHub API: 노트 목록(git tree), 노트 내용(raw) |
| `src/markdown.ts` | Obsidian 마크다운 → 안경용 텍스트 (frontmatter·주석 제거, [[링크]]·콜아웃·체크박스·표 변환) |
| `src/vault.ts` | 폴더 목록, 검색 |
| `src/layout.ts` | pretext로 G2 글자 폭을 재서 한 줄씩 미리 나누고 6줄씩 페이지로 묶음 |
| `src/glasses.ts` | 안경 레이아웃(목록 / 줄마다 컨테이너 하나, 40px 간격 = 1.5배 줄 간격). 첫 화면은 임시 화면 후 rebuild로 그림(재실행 시 빈 화면 방지) |
| `src/storage.ts` | 설정, 노트 목록, 최근 노트 10개, 읽은 위치 저장 (Even 앱 저장소) |
| `src/bridge.ts` | 모든 블루투스 호출을 한 줄로 직렬화 |

## 개발

```bash
npm.cmd install
npm.cmd run dev        # http://localhost:5173/?demo 로 열면 Obsidian 공식 도움말 보관함이 설정 칸에 미리 채워짐
npm.cmd run build
npm.cmd run pack       # out.ehpk
```
