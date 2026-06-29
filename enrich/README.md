# enrich

홈페이지 방문, 이메일 추출, 추가 연락처 보강 작업 영역입니다.

현재 이메일 추출 로직은 `src/emailExtractor.js`에 있습니다.

## Enrich Bot

Google Sheets `기업 DB` 시트에서 `홈페이지` 또는 `이메일`이 비어 있는 행만 최대 300개씩 읽어 보강합니다.

- 실행 명령: `npm run enrich -- --limit 300`
- 대상 시트: `기업 DB`
- 업데이트 컬럼: `홈페이지`, `이메일`, `메모`
- 진행 상태: `SYSTEM` 시트의 `enrich_current_row`부터 순환 스캔
- 검색 기준: `회사명 + 지역 + 업종`
- 검색 순서: Naver API 키가 있으면 Naver, 없거나 실패하면 Google, 그다음 Playwright
- 홈페이지 판정: 포털/지도/블로그/디렉터리 URL을 제외하고 회사명 일치도가 충분한 공식 후보만 반영
- 이메일 우선 패턴: `info@`, `contact@`, `sales@`, `admin@`, `master@`, `support@`, `cs@`
- 문의페이지 URL을 찾으면 `메모`에 `enrich contact=...` 형식으로 기록
- 실패 시 `메모`에 `enrich failed=...` 형식으로 사유 기록
- 실행 결과는 Google Sheets `LOG` 시트에 기록

이미 `홈페이지`와 `이메일`이 모두 있는 행은 건드리지 않습니다. 둘 중 하나만 비어 있는 행은 비어 있는 값만 보강합니다.
모든 검색 수단이 실패해도 Enrich 실행 전체를 종료하지 않고 해당 기업 메모에 `홈페이지 없음`을 기록한 뒤 다음 기업을 계속 처리합니다.

`SYSTEM` 시트에는 다음 상태를 저장합니다.

```text
enrich_current_row, enrich_total_runs, enrich_total_processed,
enrich_homepage_found, enrich_email_found, enrich_last_run_at
```
