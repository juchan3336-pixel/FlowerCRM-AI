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

## 불변 원칙

- 어떤 분기에서도 FAIL 콘텐츠는 apply·게시 준비로 진행되지 않는다.
- 원본 generation·quality issues는 상태와 무관하게 보존한다 (감사 로그).
- 주소·명칭·화환 제한 등 사실성 문제는 재시도 없이 사용자 확인 대상.
- 관리자 UI는 내부 코드를 노출하지 않고 한글 라벨(`lib/batch/reason-labels.ts`)로 표시한다.
