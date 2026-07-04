import type { Metadata } from "next"
import type { ReactNode } from "react"

import { AdminShell } from "@/components/admin/admin-shell"

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AdminShell>{children}</AdminShell>
}
