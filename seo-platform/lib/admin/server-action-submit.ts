// 클라이언트에서 서버 액션을 직접 호출할 때 쓰는 공용 래퍼.
//
// 왜 필요한가 —
// Next는 서버 액션이 redirect()로 끝나면 액션 프로미스를 redirect 오류로 **reject**한다.
// (next/dist/client/components/router-reducer/reducers/server-action-reducer.js:
//  "If the action triggered a redirect, the action promise will be rejected with a redirect
//   so that it's handled by RedirectBoundary as we won't have a valid action result…")
// 이 저장소의 batch 액션은 성공·검증 실패·환경 차단이 **모두** redirect로 끝나므로,
// try/catch가 이 reject를 그대로 실패로 처리하면 정상 요청에도 항상 실패 토스트가 뜬다(오탐).
//
// 어떻게 판별하는가 —
// digest 문자열을 직접 비교하지 않고 Next가 제공하는 unstable_rethrow를 쓴다. 이 함수는
// redirect / notFound / forbidden / unauthorized / CSR bailout 등 프레임워크 내부 제어 흐름
// 오류일 때만 다시 throw하고, 그 외에는 아무 일도 하지 않는다. error.cause 체인까지 따라가므로
// 래핑된 오류도 놓치지 않으며, digest 포맷이 바뀌어도 우리 코드가 깨지지 않는다.
//
// 다시 throw하면 어떻게 되는가 —
// AppRouter가 window의 error·unhandledrejection에 redirect 전용 핸들러를 걸어 두고 있어
// (app-router.js: "Ensure that any redirect errors that bubble up outside of the RedirectBoundary
//  are caught and handled by the router"), RedirectBoundary 또는 이 전역 핸들러가 내비게이션을
// 처리한다. 즉 재throw가 프레임워크가 기대하는 정상 경로다.
import { unstable_rethrow } from "next/navigation"

export type ServerFormActionHandlers = {
  // 진짜 전송 실패(네트워크 단절·서버 5xx 등)일 때만 호출된다.
  readonly onTransportError: () => void
  // 성공·실패·redirect 어느 쪽으로 끝나든 호출된다 (게이트 해제·모달 정리용).
  readonly onSettled?: () => void
}

export async function runServerFormAction(invoke: () => Promise<unknown>, handlers: ServerFormActionHandlers): Promise<void> {
  try {
    await invoke()
  } catch (error) {
    // redirect 계열이면 여기서 다시 throw되어 프레임워크가 내비게이션을 처리한다.
    // 그 아래 줄은 실제 오류일 때만 실행된다.
    unstable_rethrow(error)
    handlers.onTransportError()
  } finally {
    // 재throw 여부와 무관하게 항상 실행된다 — pending 해제·모달 정리가 누락되지 않는다.
    handlers.onSettled?.()
  }
}
