// 서버 액션 redirect 오탐 회귀 방어.
// Next는 액션이 redirect()로 끝나면 액션 프로미스를 redirect 오류로 reject한다
// (server-action-reducer: "the action promise will be rejected with a redirect").
// batch 액션은 성공·검증 실패 모두 redirect로 끝나므로, 이 신호를 실패로 변환하면 항상 오탐 토스트가 뜬다.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ApprovalLaunchFormView } from "@/components/admin/approval-launch-form"
import { BATCH_SUBMIT_FAILED_MESSAGE, BatchLaunchFormView } from "@/components/admin/batch-launch-form"
import { PUBLISH_SUBMIT_FAILED_MESSAGE, BatchPublishFormView } from "@/components/admin/batch-publish-form"
import { runServerFormAction } from "@/lib/admin/server-action-submit"

// Next가 클라이언트에 넘기는 redirect 오류와 동일한 형태 (digest: NEXT_REDIRECT;<type>;<url>;<status>;).
function redirectError(destination: string, type: "push" | "replace" = "push"): Error {
  return Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${type};${destination};307;` })
}

describe("runServerFormAction — redirect 제어 신호와 실제 오류 분리", () => {
  it("성공 후 redirect를 실패 메시지로 바꾸지 않고 다시 throw한다", async () => {
    // Given: 배치가 정상 생성돼 진행 화면으로 redirect된 상황.
    const onTransportError = vi.fn()
    const thrown = redirectError("/admin/batch/7a4c43b9-6047-4460-b223-27104a0c64d5?start=1", "replace")

    // When / Then: redirect는 그대로 다시 throw되어 프레임워크가 내비게이션을 처리한다.
    await expect(
      runServerFormAction(() => Promise.reject(thrown), { onTransportError }),
    ).rejects.toBe(thrown)

    // Then: 실패 처리는 한 번도 호출되지 않는다 (오탐 토스트 없음).
    expect(onTransportError).not.toHaveBeenCalled()
  })

  it("서버 검증 실패로 ?error= 로 되돌아오는 redirect도 전송 실패로 처리하지 않는다", async () => {
    // Given: 승인 체크박스를 빠뜨려 서버가 검증으로 막고 같은 경로로 redirect한 상황.
    const onTransportError = vi.fn()
    const thrown = redirectError("/admin/batch/publish/new?error=publish-not-approved", "replace")

    await expect(runServerFormAction(() => Promise.reject(thrown), { onTransportError })).rejects.toBe(thrown)

    // Then: 서버 오류 안내는 redirect 대상 화면의 BatchServerErrorToast가 담당한다 — 여기서 중복 실패 토스트를 띄우지 않는다.
    expect(onTransportError).not.toHaveBeenCalled()
  })

  it("cause 체인에 감싸인 redirect도 실패로 처리하지 않는다", async () => {
    // Given: 중간 계층이 redirect 오류를 감싸서 다시 던진 경우.
    const onTransportError = vi.fn()
    const inner = redirectError("/admin/batch/new?error=already-running")
    const wrapped = new Error("action dispatch failed", { cause: inner })

    // Then: cause 체인을 따라가 안쪽 redirect 오류를 그대로 다시 throw한다.
    await expect(runServerFormAction(() => Promise.reject(wrapped), { onTransportError })).rejects.toBe(inner)
    expect(onTransportError).not.toHaveBeenCalled()
  })

  it("실제 전송 오류는 한글 실패 메시지 경로로 처리하고 다시 throw하지 않는다", async () => {
    // Given: 네트워크 단절 등 진짜 실패.
    const onTransportError = vi.fn()

    await expect(
      runServerFormAction(() => Promise.reject(new TypeError("Failed to fetch")), { onTransportError }),
    ).resolves.toBeUndefined()

    expect(onTransportError).toHaveBeenCalledTimes(1)
  })

  it("digest 없는 일반 Error도 실제 오류로 처리한다 — NEXT_REDIRECT 문자열만 보고 판단하지 않는다", async () => {
    // Given: 메시지에 NEXT_REDIRECT가 들어 있지만 digest가 없는 오류 (redirect 신호가 아니다).
    const onTransportError = vi.fn()

    await expect(
      runServerFormAction(() => Promise.reject(new Error("NEXT_REDIRECT")), { onTransportError }),
    ).resolves.toBeUndefined()

    expect(onTransportError).toHaveBeenCalledTimes(1)
  })

  it("redirect로 끝나도 onSettled가 실행돼 pending 게이트·모달이 남지 않는다", async () => {
    // Given: redirect로 끝나는 정상 요청.
    const onSettled = vi.fn()

    await expect(
      runServerFormAction(() => Promise.reject(redirectError("/admin/batch/abc?start=1")), {
        onTransportError: () => undefined,
        onSettled,
      }),
    ).rejects.toBeDefined()

    // Then: 재throw 여부와 무관하게 정리 콜백은 반드시 1회 실행된다.
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("실제 오류에서도, 성공에서도 onSettled는 1회 실행된다", async () => {
    const onFailureSettled = vi.fn()
    await runServerFormAction(() => Promise.reject(new Error("boom")), { onTransportError: () => undefined, onSettled: onFailureSettled })
    expect(onFailureSettled).toHaveBeenCalledTimes(1)

    const onSuccessSettled = vi.fn()
    const onTransportError = vi.fn()
    await runServerFormAction(() => Promise.resolve(undefined), { onTransportError, onSettled: onSuccessSettled })
    expect(onSuccessSettled).toHaveBeenCalledTimes(1)
    expect(onTransportError).not.toHaveBeenCalled()
  })
})

describe("실패 메시지는 안전한 한글 안내만 노출한다", () => {
  it("생성·게시 실패 문구에 stack trace·내부 코드·시크릿이 없다", () => {
    for (const message of [BATCH_SUBMIT_FAILED_MESSAGE, PUBLISH_SUBMIT_FAILED_MESSAGE]) {
      expect(message).toContain("네트워크 상태를 확인한 뒤 다시 시도해 주세요")
      expect(message).not.toMatch(/NEXT_REDIRECT|digest|at\s+\w+\s+\(|https?:\/\/|sk-|SUPABASE|Error:/)
    }
  })
})

describe("확인 모달은 요청이 끝나면 부모가 닫는다", () => {
  it("AI 일괄 생성 폼의 모달 상태를 부모가 제어할 수 있다", () => {
    // Given: 부모가 confirmOpen=false로 내려보낸 상태 (요청 종료 후).
    const closed = renderToStaticMarkup(
      <BatchLaunchFormView
        candidates={[{ placeId: "11111111-1111-4111-8111-111111111111", name: "김해복음병원 장례식장", region: "경남", address: null, eligible: true, reason: null }]}
        confirmOpen={false}
        initialConfirmOpen
        isPending={false}
        productionBlocked={false}
        usdKrwRate={1400}
      />,
    )

    // Then: initialConfirmOpen보다 부모 제어값이 우선해 모달이 남지 않는다.
    expect(closed).not.toContain("일괄 생성 최종 확인")
    expect(closed).not.toContain('role="dialog"')
  })

  it("부모 제어값이 없으면 기존 initialConfirmOpen 동작을 유지한다 (회귀 방어)", () => {
    const open = renderToStaticMarkup(
      <BatchLaunchFormView
        candidates={[{ placeId: "11111111-1111-4111-8111-111111111111", name: "김해복음병원 장례식장", region: "경남", address: null, eligible: true, reason: null }]}
        initialConfirmOpen
        initialSelected={["11111111-1111-4111-8111-111111111111"]}
        isPending={false}
        productionBlocked={false}
        usdKrwRate={1400}
      />,
    )
    expect(open).toContain("일괄 생성 최종 확인")
    expect(open).toContain('role="dialog"')
  })

  it("승인 자동 생성 폼의 모달 제어 계약은 그대로다 (PR-D 회귀 방어)", () => {
    const closed = renderToStaticMarkup(
      <ApprovalLaunchFormView
        candidates={[
          {
            placeId: "22222222-2222-4222-8222-222222222222",
            name: "김해복음병원 장례식장",
            region: "경남",
            address: "경남 김해시 활천로 33",
            phone: "055-330-9999",
            verifiedAt: null,
            verificationSourceUrls: [],
            estimatedTokens: 1250,
            estimatedCostUsd: 0.001,
            eligible: true,
            reason: null,
          },
        ]}
        confirmOpen={false}
        initialConfirmOpen
        isPending={false}
        usdKrwRate={1400}
      />,
    )
    expect(closed).not.toContain("자동 생성 최종 승인")
  })
})

describe("게시 폼 pending·중복 클릭 차단 회귀", () => {
  const CANDIDATE = {
    placeId: "33333333-3333-4333-8333-333333333333",
    name: "김해복음병원 장례식장",
    region: "경남",
    path: "/places/funeral-gyeongnam-gimhaesi-gimhaebogeumbyeongwon-jangryesikjang",
    eligible: true,
    reason: null,
  } as const

  it("pending 중에는 버튼·체크박스가 잠기고 spinner가 보인다", () => {
    const markup = renderToStaticMarkup(
      <BatchPublishFormView candidates={[CANDIDATE]} envBlocked={false} initialSelected={[CANDIDATE.placeId]} isPending />,
    )
    expect(markup).toContain("배치 준비 중...")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it("유휴 상태에서는 선택 건수를 붙인 시작 버튼만 보인다", () => {
    const markup = renderToStaticMarkup(
      <BatchPublishFormView candidates={[CANDIDATE]} envBlocked={false} initialSelected={[CANDIDATE.placeId]} isPending={false} />,
    )
    expect(markup).toContain("일괄 게시 시작 (1건)")
    expect(markup).not.toContain("animate-spin")
  })
})
