export type AdminPasswordResetUser = {
  readonly id: string
  readonly email: string | null
}

export type AdminPasswordResetClient = {
  listUsers(input?: Readonly<{ page?: number; perPage?: number }>): Promise<Readonly<{ data: Readonly<{ users: readonly AdminPasswordResetUser[] }>; error: { readonly message: string } | null }>>
  updateUserById(userId: string, attributes: Readonly<{ password: string; email_confirm: true }>): Promise<Readonly<{ data: Readonly<{ user: AdminPasswordResetUser | null }>; error: { readonly message: string } | null }>>
}

export type AdminPasswordResetInput = {
  readonly client: AdminPasswordResetClient
  readonly email: string
  readonly password: string
}

export type AdminPasswordResetResult =
  | { readonly kind: "updated"; readonly email: string; readonly userId: string }
  | { readonly kind: "user_not_found"; readonly email: string }
  | { readonly kind: "lookup_failed"; readonly message: string }
  | { readonly kind: "update_failed"; readonly email: string; readonly message: string }

export function resetAdminPasswordForEmail(input: AdminPasswordResetInput): Promise<AdminPasswordResetResult>
