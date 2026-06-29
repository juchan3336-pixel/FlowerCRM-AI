# FlowerCRM-AI

부산, 김해, 양산, 창원, 울산 지역의 B2B 화환 영업용 기업 DB를 수집하고 Google Sheets CRM에 저장하는 자동화 프로젝트입니다.

## 주요 기능

- 카카오 로컬 API 기반 기업 후보 수집
- 대상 지역: 부산, 김해, 양산, 창원, 울산
- 대상 업종: 건설회사, 시행사, 종합건설, 병원, 제조업체, 법무법인, 세무법인, 회계법인, 자동차 딜러, 호텔
- 수집 컬럼: 회사명, 업종, 세부업종, 지역, 주소, 대표전화, 홈페이지, 이메일, 출처URL, 수집일, 등급, 영업상태, 메모
- 전화번호 없는 데이터 제외
- 지역 불일치 데이터 제외
- 업종 오분류 필터링
- 회사명 + 대표전화 기준 중복 제외
- Google Sheets API 저장
- 수집 요약 리포트 및 로그 생성

## 프로젝트 구조

```text
collect/      수집 실행 진입점과 수집 관련 문서
enrich/       홈페이지/이메일 보강 작업 영역
score/        등급화 및 영업 우선순위 작업 영역
automation/   Google Sheets 업로드 및 운영 자동화
dashboard/    향후 CRM 대시보드 작업 영역
reports/      리포트 산출물 작업 영역
src/          핵심 수집/정규화/필터/Google API 코드
test/         Node test 기반 테스트
work/         운영 보조 스크립트
logs/         실행 로그, Git에는 .gitkeep만 포함
outputs/      수집 결과 파일, Git 제외
```

## Google Sheets 대상

- Google Drive 폴더: `전국팔도꽃배달 CRM`
- 스프레드시트: `기업DB`
- 기본 시트: `기업 DB`, `신규기업`, `영업대상`, `거래기업`, `제외기업`

## 등급 규칙

- A등급: 건설, 시행, 종합건설, 병원
- B등급: 제조, 금융, 자동차 딜러, 호텔
- C등급: 법무, 세무, 회계

## 환경 변수

`.env.example`을 `.env`로 복사한 뒤 값을 입력합니다.

```powershell
Copy-Item .env.example .env
```

필수 값:

```env
KAKAO_REST_API_KEY=
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\google-service-account.json
GOOGLE_SPREADSHEET_ID=1vVk6WU-l1ILjLCY95Ua1SPqRxOTAh6tkyWjDjzbHvO0
GOOGLE_DRIVE_FOLDER_ID=1J-WmPxvc7FgD1nl6yeVnHJgalZGXoNRN
```

서비스 계정 이메일을 `기업DB` Google Sheets 파일에 편집자로 공유해야 합니다.

## 실행

테스트:

```powershell
npm.cmd test
```

수집:

```powershell
$env:KAKAO_REST_API_KEY="..."
node .\work\collect_kakao_batch.mjs 1000 1 3 kakao_next_1000
```

Google Sheets 저장:

```powershell
node .\work\write_rows_to_sheets.mjs .\outputs\kakao_next_1000_rows.json
```

보강:

```powershell
npm run enrich -- --limit 300
```

## 운영형 Collect Bot

운영 수집은 Queue + Google Sheets `SYSTEM` 시트 기반으로 동작합니다. GitHub Actions를 수동 재실행하거나 스케줄로 실행해도, 진행 위치는 저장소 파일이 아니라 `SYSTEM` 시트에서 읽습니다.

- 실행 명령: `npm run collect -- --limit 300`
- 1회 실행 목표: Google Sheets 기준 신규 기업 300개 추가
- 중복 기준: `회사명 + 대표전화`
- 중복 범위: `기업 DB`, `신규기업`, `영업대상`, `거래기업`, `제외기업` 전체
- 큐 정의 파일: `collect_queue.json`
- 운영 상태 저장소: Google Sheets `SYSTEM` 시트
- 로컬 상태 미러: `collect_state.json`

`collect_queue.json`에는 지역/업종/키워드 조합이 저장됩니다. 한 번 실행이 끝나면 다음 큐 위치와 누적 통계를 Google Sheets `SYSTEM` 시트에 기록하고, 다음 실행은 `SYSTEM` 시트의 `current_queue_index`부터 이어서 진행합니다.

큐 대상:

- 지역: 부산, 김해, 양산, 창원, 울산, 경남, 대구, 경북, 서울, 경기, 인천
- 업종: 건설회사, 종합건설, 시행사, 병원, 법무법인, 세무법인, 회계법인, 호텔, 제조업, 자동차딜러, 금융기관, 프랜차이즈본사

`SYSTEM` 시트 컬럼:

```text
key, value, updated_at, memo
```

주요 저장 항목:

```text
current_region, current_category, current_keyword, current_queue_index,
total_runs, total_collected, total_new_added, total_duplicates,
last_run_at, next_region, next_category, next_keyword, failure_counts
```

특정 queue에서 3회 연속 실패하면 해당 queue는 skip 처리하고 다음 queue로 이동합니다. 실패 횟수는 `SYSTEM` 시트의 `failure_counts`에 저장됩니다. 실행 요약은 Actions 로그와 `logs/`에 남습니다.

`LOG` 시트에는 매 실행 결과가 누적됩니다.

```text
실행일시, 현재큐, 다음큐, 수집시도수, 신규추가수, 중복제외수,
전화번호없음, 지역불일치, 업종불일치, 실행시간, 상태, 메모
```

운영 전 작은 테스트가 필요하면 dry-run으로 실행할 수 있습니다. dry-run은 Kakao 수집과 중복 판단은 수행하지만 기업DB/SYSTEM/LOG 시트에는 쓰지 않습니다.

```powershell
npm run collect -- --limit 5 --dry-run
```

## Kakao API 단독 테스트

Collect 전체 실행 전에 Kakao Local API 검색이 정상 동작하는지 Google Sheets 저장 없이 확인할 수 있습니다. 이 명령은 `KAKAO_REST_API_KEY`만 확인하고, `기업DB`, `SYSTEM`, `LOG` 시트는 절대 업데이트하지 않습니다.

```powershell
npm run collect:test-query -- --region 김해 --keyword 의원
npm run collect:test-query -- --region 부산 --keyword 병원
npm run collect:test-query -- --region 창원 --keyword 세무법인
npm run collect:test-query -- --region 양산 --keyword 자동차매매
```

출력 항목:

```text
query, request url(API key masking), response status, documents length, meta,
회사명, 카테고리, 주소, 전화번호, place_url
```

## 운영형 Enrich Bot

Enrich Bot은 Google Sheets `기업 DB` 시트에서 `홈페이지` 또는 `이메일`이 비어 있는 행만 읽어 자동 보강합니다. Collect Bot과 분리된 `src/enrich.js`, `src/enrichCli.js` 경로로 동작하며, Google Sheets `SYSTEM` 시트에 진행 행 번호와 누적 통계를 저장합니다.

- 실행 명령: `npm run enrich -- --limit 300`
- 1회 처리 한도: 300개
- 대상 조건: `홈페이지` 또는 `이메일`이 비어 있는 행
- 보호 규칙: 이미 `홈페이지`와 `이메일`이 모두 있는 행은 건드리지 않음
- 진행 상태: `SYSTEM` 시트의 `enrich_current_row`부터 순환 스캔
- 검색 기준: 네이버 중심의 `회사명 + 주소 일부`, `회사명 + 지역`, 공식 홈페이지/고객센터/문의/이메일 쿼리
- 홈페이지 업데이트: 공식 홈페이지로 판단되는 URL만 `홈페이지` 컬럼에 기록
- 지도/구인구직/블로그/뉴스 URL은 홈페이지로 저장하지 않고, 해당 페이지 안 공식 홈페이지 링크만 따라감
- 이메일 추출: 홈페이지와 문의성 페이지에서 `info@`, `contact@`, `sales@`, `admin@`, `master@`, `support@`, `cs@` 우선 추출
- 이메일 discovery: 홈페이지에서 이메일을 못 찾으면 회사명 기반 검색 결과와 결과 페이지 본문에서 이메일을 추가 탐색
- Job Site discovery: 사람인, 잡코리아, 워크넷, 인크루트, 잡플래닛, 원티드, 로켓펀치에서 공식 홈페이지/담당자 이메일 보조 탐색
- 문의페이지 기록: 문의페이지 URL 발견 시 `메모` 컬럼에 기록
- 이메일 출처 기록: discovery로 이메일을 찾으면 `메모` 컬럼에 출처 URL 기록
- 실패 기록: 공식 홈페이지 또는 이메일 보강 실패 시 `메모` 컬럼에 사유 기록
- 실행 결과: Google Sheets `LOG` 시트와 `logs/` 파일에 기록

홈페이지 검색은 Naver API를 우선 사용하고, 지도 sourceUrl 내부 공식 링크, Playwright, Google 순서로 fallback합니다. 모두 실패해도 해당 기업 메모에 실패 사유를 기록하고 다음 기업을 계속 처리합니다.

Enrich Bot이 `SYSTEM` 시트에 저장하는 항목:

```text
enrich_current_row, enrich_total_runs, enrich_total_processed,
enrich_homepage_found, enrich_email_found, enrich_last_run_at
```

디버그 실행:

```powershell
npm run enrich -- --limit 10 --debug
```

## GitHub Actions

`.github/workflows/ci.yml`은 push와 pull request 때 Node 테스트를 실행합니다.

`.github/workflows/collect.yml`은 `FlowerCRM Collect` 운영 수집 워크플로입니다.

- 수동 실행: GitHub Actions의 `Run workflow`
- 예약 실행: KST 00시, 03시, 06시, 09시, 12시, 15시, 18시, 21시
- Node.js: 24
- 실행 명령: `npm run collect -- --limit 300`
- 진행 상태: Google Sheets `SYSTEM` 시트에 저장

`.github/workflows/kakao-test.yml`은 Google Sheets 저장 없이 Kakao API 검색만 확인하는 수동 테스트 워크플로입니다.

- 수동 실행: GitHub Actions의 `Run workflow`
- 입력값: `region`, `keyword`
- 실행 명령: `npm run collect:test-query -- --region <region> --keyword <keyword>`
- 저장 동작: 없음. Google Sheets, Queue, SYSTEM, LOG를 업데이트하지 않음

`.github/workflows/enrich.yml`은 `FlowerCRM Enrich` 운영 보강 워크플로입니다.

- 수동 실행: GitHub Actions의 `Run workflow`
- 예약 실행: 하루 8회, Collect 실행 약 25분 후
- Node.js: 24
- 실행 명령: `npm run enrich -- --limit 300`
- 실행 결과: Google Sheets `LOG` 시트에 저장

API 키와 서비스 계정 JSON은 저장소에 올리지 않고 GitHub Secrets로 관리합니다.

필수 Secrets:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `KAKAO_REST_API_KEY`

등록 위치:

```text
GitHub Repository > Settings > Secrets and variables > Actions > New repository secret
```

`GOOGLE_SERVICE_ACCOUNT_JSON`에는 서비스 계정 JSON 파일의 전체 내용을 넣습니다. `KAKAO_REST_API_KEY`에는 Kakao Developers REST API 키 값을 넣습니다.

선택 Secrets:

- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `OPENAI_API_KEY`

## 보안

다음 파일과 폴더는 Git에 올리지 않습니다.

- `.env`
- `google-service-account.json`
- `outputs/`
- 실행 로그 파일
- `node_modules/`
