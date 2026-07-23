# Content Quality 정책 (v1.1 — 2026-07-22 개정)

Batch 생성·단건 생성에 공통 적용되는 콘텐츠 품질 판정과 후속 상태 정책.
코드 기준: `lib/ai/content-quality`(검사), `lib/batch/quality-policy.ts`(분기), `lib/batch/generation-batch-service.ts`(기록).

## 검사 임계값 (v1 유지)

- 첫 문장 Jaccard 0.85 이상: FAIL
- 기존 페이지와 동일 문장 2개 이상: FAIL
- FAQ 질문 2개 모두 동일: FAIL
- 금지 표현(배송 확정·보장, 제휴·지정 오인 등): FAIL
- 제목 구조 반복: WARN
- 키워드 5개 중 4개 이상 중복: WARN

## Batch item 상태 분기 (v1.1 — 실동작 기준으로 명문화)

| 판정 | item 상태 | 의미 |
|---|---|---|
| PASS / issues 0 | `ready` | 자동 apply + 게시 준비 |
| WARN 1건이며 `repeat:title` 단독 | `warn_ready` | 자동 apply (auto-ready 정책) |
| 그 외 WARN 1건 / WARN 2건 이상 | `needs_review` | preview 보존, 사용자 검토 |
| **콘텐츠 FAIL (금지 표현·반복 등 검토 가능한 결함)** | **`needs_review`** | **apply 차단 + preview 보존 — 사람이 검토·회수할 수 있는 결함은 실패가 아니라 확인 대기다** |
| `repeat:faq` 단독 FAIL | 제어 재시도 1회 → 재판정 | 원본 generation 보존 |
| 재시도 후에도 FAIL | `failed` | 시스템이 자동 복구를 소진함 |
| 생성 호출 실패·품질 성적표 계산 불가·적용 차단·예상외 오류 | `failed` | **시스템 오류·검증 불가 전용** |

### v1.0 → v1.1 변경 요지

- v1.0 문서는 "repeat:faq 외 FAIL → failed"로 기술했으나, 실제 서비스 동작(2026-07-22 4건 실측의 `banned:delivery-guarantee` 사례로 실증)은 콘텐츠 FAIL을 `needs_review`로 기록한다.
- v1.1은 **코드를 바꾸지 않고 문서를 실동작에 맞춘다**: 검토 가능한 콘텐츠 결함은 사람이 preview를 보고 판단할 수 있어야 하므로 `needs_review`가 올바른 종착지다. `failed`는 사람이 검토할 산출물이 없거나(생성 실패·품질 계산 불가) 시스템이 자동 복구를 소진한 경우로 한정한다.
- `lib/batch/quality-policy.ts`의 `kind: "failed"` 반환값은 분기 의도(자동 진행 불가)를 나타내며, 서비스 계층이 preview 보존과 함께 `needs_review`로 수용한다 — 두 계층의 역할 주석 참조.

### v1.2 — 복구 재시도 소진 판정 (2026-07-23)

- 복구 재시도는 **원본 generation당 1회**이며, 소진 여부는 **시간과 무관한 내구적 기록**으로만 판정한다.
- 소진으로 보는 흔적 (`lib/ai/retry-policy.ts`):
  1. 원본을 참조하는 generation(`output.retry.of`) — 상태 무관(`preview` / `applied` / `failed`).
  2. 원본을 처리한 Batch item — `retry_generation_id`가 있거나, `last_error_code`가 `retry-`로 시작하거나, `last_error_message`가 `복구 재시도 실패: `로 시작.
- 두 흔적은 합산하지 않고 `Math.max`로 센다 (재시도 generation이 남은 Batch 실행은 양쪽에 모두 잡힌다).
- 관리자 UI의 재시도 버튼과 서버 액션은 **같은 판정 함수**(`decideQualityFailRetry`)를 쓴다 — 버튼이 보이지 않으면 서버 직접 호출도 차단된다.
- **Batch의 제어 재시도도 같은 판정 함수를 거친다.** 차단되면 재생성 없이 `needs_review` + `quality-fail-retry-blocked`로 남긴다 (차단은 소진이 아니므로 `retry-` 접두를 쓰지 않는다).
- 최근 preview 60초 가드(`RECENT_PREVIEW_GUARD_SECONDS`)는 **일반 생성 재클릭 전용**이다. Batch는 원본 생성 직후 재시도하므로 복구 재시도 경로는 이 가드를 우회한다 (중복 방지는 재시도 1회 정책과 in-flight 잠금이 담당).

#### retry generation이 남지 않은 시도의 소진 기준

판정 기준은 하나 — **provider 호출이 실제로 시작됐는가** (`isRetryAttemptConsumed`). 부작용이 없는 시도는 재시도 1회를 소모하지 않는다.

| 재시도 결과 | 남는 기록 | 소진 |
|---|---|---|
| `generated` | 재시도 generation (`output.retry.of`) | **소진** |
| `failed` (timeout·rate_limit·network·invalid_response·json_parse·provider_error·guardrail) | 실패 generation 레코드 + `output.retry.of`, Batch item `retry-<code>` | **소진** |
| `misconfigured` (api_key_missing·provider_config) | 실패 레코드(retry 감사 기록 **없음**), Batch item은 접두 없는 코드 | 소진 아님 — 호출 전 차단, 부작용 없음 |
| `busy` (같은 장소 in-flight 잠금) | 없음 | 소진 아님 — 시도 자체가 없었음 |
| `recent-preview` | 해당 없음 | 복구 재시도 경로는 이 가드를 우회하므로 발생하지 않음 |

- 배경: 2026-07-23 대구병원 실측에서 복구 재시도가 60초 가드에 막혀 generation을 남기지 못했고, 그 결과 소진 사실이 generation 계층에 기록되지 않아 60초 경과 뒤 2회차 재시도가 다시 열렸다.
- 그 실측 행(`last_error_code='recent-preview'` + `last_error_message='복구 재시도 실패: …'`)은 접두 규칙 도입 이전 기록이므로 **메시지 접두로 소진 처리**한다 — 시스템이 자동 복구를 이미 시도·포기한 건이므로 재개 여부는 운영자가 명시적으로 결정한다. 신규 실행에서 소진이 아닌 실패는 `복구 재시도 시작 불가: …` 메시지를 써서 이 접두와 겹치지 않는다.

## 불변 원칙

- 어떤 분기에서도 FAIL 콘텐츠는 apply·게시 준비로 진행되지 않는다.
- 원본 generation·quality issues는 상태와 무관하게 보존한다 (감사 로그).
- 주소·명칭·화환 제한 등 사실성 문제는 재시도 없이 사용자 확인 대상.
- 관리자 UI는 내부 코드를 노출하지 않고 한글 라벨(`lib/batch/reason-labels.ts`)로 표시한다.

### v1.3 — needs_review 해소 정식 경로 (2026-07-23)

`needs_review`는 종료 상태였고 `recordItemResult`는 `processing`에서만 전이하므로, 관리자가 검토·보정한 콘텐츠를 `ready`로 올릴 정식 경로가 없었다. 2026-07-23 K병원 예지원 건은 그래서 조건부 직접 UPDATE로 처리됐다(legacy/manual-resolution — 되돌리지 않고 회귀 테스트 fixture로만 사용한다).

- 상태 머신에 `needs_review → processing` 전이를 추가한다. 자동 진행(`claimableStatusesFor`)에는 포함하지 않아 Batch 루프는 여전히 `needs_review`를 집지 않는다.
- 정식 경로: `needs_review` → `processing`(`checking` → `applying`) → `ready`. 전이는 전부 조건부 UPDATE이며, 실패하면 `needs_review`로 되돌려 `processing` 잔류를 남기지 않는다.
- 보정 허용 필드는 `title` · `meta_description` · `body` · `faq` · `keywords` · `internal_links` 6개뿐이다. 명시 선택된 필드만 바뀌고, 변경 전 값과 변경 필드 목록은 `output.manual_review`에 남는다. provider/model/usage/estimated_cost/content_plan/audit/title_normalization과 `input`은 대상이 아니다.
- 보정 콘텐츠는 생성 경로와 같은 스키마·가드레일(`parseAiProviderOutput` + `assertAiOutputAllowed`)을 통과해야 하며, 재평가가 PASS(issues 0)가 아니면 apply 없이 `needs_review`를 유지한다.
- AI 재생성은 하지 않는다 — 토큰·비용이 추가되지 않는다.
- 이벤트는 `item_claimed`(detail.trigger=`review`) → `item_step_changed` → `item_result_recorded` 3종으로 남는다. 전용 `review_resolution_started` 이벤트 타입은 `batch_run_events.event_type` CHECK 제약 변경(migration)이 필요해 v1에서는 도입하지 않았다.
