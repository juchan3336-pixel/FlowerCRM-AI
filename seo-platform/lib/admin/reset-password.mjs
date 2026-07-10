import { z } from "zod"

const emailSchema = z.string().trim().pipe(z.email())
const passwordSchema = z.string().min(1)

export async function resetAdminPasswordForEmail(input) {
  const parsedEmail = emailSchema.safeParse(input.email)
  if (!parsedEmail.success) {
    return { kind: "lookup_failed", message: "Invalid admin email" }
  }

  const parsedPassword = passwordSchema.safeParse(input.password)
  if (!parsedPassword.success) {
    return { kind: "update_failed", email: parsedEmail.data, message: "Password must not be empty" }
  }

  const { data, error } = await input.client.listUsers({ page: 1, perPage: 1000 })
  if (error !== null) {
    return { kind: "lookup_failed", message: error.message }
  }

  const user = data.users.find((entry) => normalizeEmail(entry.email) === parsedEmail.data.toLowerCase())
  if (user === undefined) {
    return { kind: "user_not_found", email: parsedEmail.data }
  }

  const { error: updateError } = await input.client.updateUserById(user.id, { password: parsedPassword.data, email_confirm: true })
  if (updateError !== null) {
    return { kind: "update_failed", email: parsedEmail.data, message: updateError.message }
  }

  return { kind: "updated", email: parsedEmail.data, userId: user.id }
}

function normalizeEmail(value) {
  return value === null ? null : value.trim().toLowerCase()
}
