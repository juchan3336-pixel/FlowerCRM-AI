import { describe, expect, it } from "vitest"

import { resetAdminPasswordForEmail, type AdminPasswordResetClient } from "@/lib/admin/reset-password"

describe("admin password reset script", () => {
  it("updates the matched auth user password by email", async () => {
    // Given: a service-role admin client with a matching auth user.
    const client = new AdminPasswordResetClientStub([
      { id: "user_1", email: "admin@midmgroup.com" },
      { id: "user_2", email: "juchan3336@gmail.com" },
    ])

    // When: the operator requests a direct password change.
    const result = await resetAdminPasswordForEmail({
      client,
      email: "admin@midmgroup.com",
      password: "new-password-123",
    })

    // Then: the correct user is updated and email verification stays enabled.
    expect(result).toEqual({ kind: "updated", email: "admin@midmgroup.com", userId: "user_1" })
    expect(client.updatedUsers).toEqual([{ userId: "user_1", password: "new-password-123", emailConfirm: true }])
  })

  it("returns not found when the email is not present in Supabase Auth", async () => {
    // Given: an auth user list without the requested email.
    const client = new AdminPasswordResetClientStub([{ id: "user_1", email: "admin@midmgroup.com" }])

    // When: the operator requests a password change for a missing email.
    const result = await resetAdminPasswordForEmail({
      client,
      email: "missing@example.com",
      password: "new-password-123",
    })

    // Then: no update is attempted and the script reports the lookup failure.
    expect(result).toEqual({ kind: "user_not_found", email: "missing@example.com" })
    expect(client.updatedUsers).toEqual([])
  })
})

class AdminPasswordResetClientStub implements AdminPasswordResetClient {
  readonly updatedUsers: { readonly userId: string; readonly password: string; readonly emailConfirm: boolean }[] = []
  private readonly users: readonly { readonly id: string; readonly email: string | null }[]

  constructor(users: readonly { readonly id: string; readonly email: string | null }[]) {
    this.users = users
  }

  listUsers(): Promise<Readonly<{ data: Readonly<{ users: readonly { readonly id: string; readonly email: string | null }[] }>; error: { readonly message: string } | null }>> {
    return Promise.resolve({ data: { users: this.users }, error: null })
  }

  updateUserById(userId: string, attributes: Readonly<{ password: string; email_confirm: true }>): Promise<Readonly<{ data: Readonly<{ user: { readonly id: string; readonly email: string | null } | null }>; error: { readonly message: string } | null }>> {
    this.updatedUsers.push({ userId, password: attributes.password, emailConfirm: true })
    const user = this.users.find((entry) => entry.id === userId) ?? null
    return Promise.resolve({ data: { user }, error: null })
  }
}
