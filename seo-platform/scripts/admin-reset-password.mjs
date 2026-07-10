import { createClient } from "@supabase/supabase-js"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

await bootstrap()

async function bootstrap() {
  await loadEnvFile(join(repoRoot, ".env.local"))
  await loadEnvFile(join(repoRoot, ".env"))

  const argv = parseArgv(process.argv.slice(2))
  if (argv.kind !== "ok") {
    printUsage(argv.message)
    process.exitCode = 1
    return
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (supabaseUrl === undefined || serviceRoleKey === undefined) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    process.exitCode = 1
    return
  }

  const supabase = createClient(normalizeSupabaseProjectUrl(supabaseUrl), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const result = await resetAdminPasswordForEmail({
    client: {
      listUsers(input) {
        return supabase.auth.admin.listUsers(input)
      },
      updateUserById(userId, attributes) {
        return supabase.auth.admin.updateUserById(userId, attributes)
      },
    },
    email: argv.value.email,
    password: argv.value.password,
  })

  switch (result.kind) {
    case "updated":
      console.log(`Updated password for ${result.email} (${result.userId})`)
      return
    case "user_not_found":
      console.error(`User not found: ${result.email}`)
      process.exitCode = 1
      return
    case "lookup_failed":
      console.error(`Lookup failed: ${result.message}`)
      process.exitCode = 1
      return
    case "update_failed":
      console.error(`Update failed for ${result.email}: ${result.message}`)
      process.exitCode = 1
      return
  }
}

function parseArgv(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current?.startsWith("--")) {
      return { kind: "error", message: `Unexpected argument: ${String(current)}` }
    }

    const key = current.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `Missing value for --${key}` }
    }

    args.set(key, value)
    index += 1
  }

  const email = args.get("email")
  const password = args.get("password")
  if (typeof email !== "string" || typeof password !== "string") {
    return { kind: "error", message: "Both --email and --password are required" }
  }

  return { kind: "ok", value: { email, password } }
}

function printUsage(message) {
  console.log(message)
  console.log("Usage: node scripts/admin-reset-password.mjs --email admin@midmgroup.com --password NEW_PASSWORD")
}

async function loadEnvFile(filePath) {
  try {
    const contents = await readFile(filePath, "utf8")
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue
      }

      const equalsIndex = trimmed.indexOf("=")
      if (equalsIndex <= 0) {
        continue
      }

      const key = trimmed.slice(0, equalsIndex)
      const value = trimQuotes(trimmed.slice(equalsIndex + 1))
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  } catch {
    return
  }
}

function trimQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }

  return value
}

function normalizeSupabaseProjectUrl(value) {
  const trimmed = value.trim()
  try {
    return new URL(trimmed).origin
  } catch {
    return trimmed
  }
}

async function resetAdminPasswordForEmail(input) {
  const { resetAdminPasswordForEmail: reset } = await import("../lib/admin/reset-password.mjs")
  return reset(input)
}
