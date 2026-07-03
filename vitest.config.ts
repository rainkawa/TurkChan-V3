import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    pool: 'threads',
    testTimeout: 20000,
  },
})
