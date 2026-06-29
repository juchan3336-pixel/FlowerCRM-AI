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

## GitHub Actions

`.github/workflows/ci.yml`은 push와 pull request 때 Node 테스트를 실행합니다. API 키와 서비스 계정 JSON은 저장소에 올리지 않고, 운영 자동화가 필요할 때 GitHub Secrets로 관리합니다.

## 보안

다음 파일과 폴더는 Git에 올리지 않습니다.

- `.env`
- `google-service-account.json`
- `outputs/`
- 실행 로그 파일
- `node_modules/`
