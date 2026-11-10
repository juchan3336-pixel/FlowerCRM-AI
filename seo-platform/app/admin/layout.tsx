import type { Metadata } from "next"
import type { ReactNode } from "react"

import { AdminShell } from "@/components/admin/admin-shell"

export const metadata: Metadata = {
  // 관리자 화면은 내부 운영 명칭을 유지한다 — 공개 표면 template("| 팔도플라워")을 타지 않도록 absolute로 고정.
  title: { absolute: "관리자 | 팔도플라워 SEO Platform" },
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AdminShell>{children}</AdminShell>
}
