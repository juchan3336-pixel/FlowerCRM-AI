# enrich

홈페이지 방문, 이메일 추출, 추가 연락처 보강 작업 영역입니다.

현재 이메일 추출 로직은 `src/emailExtractor.js`에 있습니다.

## Enrich Bot

Google Sheets `기업 DB` 시트에서 `홈페이지` 또는 `이메일`이 비어 있는 행만 최대 300개씩 읽어 보강합니다.

- 실행 명령: `npm run enrich -- --limit 300`
- 대상 시트: `기업 DB`
- 업데이트 컬럼: `홈페이지`, `이메일`, `메모`
- 진행 상태: `SYSTEM` 시트의 `enrich_current_row`부터 순환 스캔
- 검색 기준: Playwright 브라우저 검색과 구인구직/공개 웹 검색 결과 기반의 `회사명 + 지역 + 업종`
- 검색 순서: Playwright 브라우저 검색, 구인구직 discovery, 네이버/카카오 지도 sourceUrl 내부 공식 링크 보조 fallback
- 검색 쿼리: `회사명 주소일부`, `회사명 지역`, `회사명 공식 홈페이지`, `회사명 고객센터`, `회사명 문의`, `회사명 이메일`
- 홈페이지 판정: 포털/지도/블로그/뉴스/구인구직 URL은 저장하지 않고, 페이지 안 공식 홈페이지 링크만 따라가서 자체 도메인 후보를 반영
- 주소 매칭: 기업DB 주소의 시/구/동 일부가 검색 결과나 본문에 있으면 강한 가점
- 이메일 우선 패턴: `info@`, `contact@`, `sales@`, `admin@`, `master@`, `support@`, `cs@`
- 이메일 discovery: 홈페이지에서 이메일을 못 찾으면 `회사명 이메일`, `회사명 대표메일`, `회사명 문의`, `회사명 contact`, `회사명 채용`, `회사명 사업자등록` 검색 결과에서 추가 탐색
- 제외 이메일: `gmail.com`, `naver.com`, `daum.net`, `hanmail.net`, `kakao.com`
- 문의페이지 URL을 찾으면 `메모`에 `enrich contact=...` 형식으로 기록
- discovery 출처 URL을 찾으면 `메모`에 `enrich email_source=...` 형식으로 기록
- 이메일을 못 찾으면 `메모`에 `이메일 미확보`를 기록
- 실패 시 `메모`에 실패 사유 기록
- 실행 결과는 Google Sheets `LOG` 시트에 기록

기본 Enrich 실행은 Naver/Google/Kakao REST 검색 API를 사용하지 않습니다. Collect가 저장한 `sourceUrl`은 공식 홈페이지 링크를 찾는 보조 단서로만 사용하고, 이메일은 브라우저 검색/구인구직/공개 웹 결과를 우선 탐색합니다.

이미 `홈페이지`와 `이메일`이 모두 있는 행은 건드리지 않습니다. 둘 중 하나만 비어 있는 행은 비어 있는 값만 보강합니다.
모든 검색 수단이 실패해도 Enrich 실행 전체를 종료하지 않고 해당 기업 메모에 `홈페이지 없음`을 기록한 뒤 다음 기업을 계속 처리합니다.

디버그 실행:

```powershell
npm run enrich -- --limit 10 --debug
npm run enrich -- --limit 10 --dry-run --debug --from-start
```

`--dry-run`은 기업DB/SYSTEM/LOG 시트에 쓰지 않고 검색과 판정만 수행합니다. `--from-start`는 해당 실행만 2행부터 테스트하며, 일반 운영 실행은 계속 `SYSTEM.enrich_current_row`에서 이어집니다. 특정 행부터 확인하려면 `--start-row 25`처럼 지정합니다.

`--debug`는 회사명, 주소, 검색 쿼리, provider, 후보 URL, 선택 홈페이지, 방문 내부 페이지, 발견/거절 이메일, 선택 이메일 점수와 출처, 실패 사유를 출력합니다.

`SYSTEM` 시트에는 다음 상태를 저장합니다.

```text
enrich_current_row, enrich_total_runs, enrich_total_processed,
enrich_homepage_found, enrich_email_found, enrich_last_run_at
```
