import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

const appRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: appRoot },
} satisfies NextConfig

export default nextConfig
