import { defineConfig } from 'vitest/config'

// Live tests hit the real CSDN API with a real cookie. They create drafts and
// delete them again — they must never publish anything.
// Run with: CSDN_LIVE=1 npm run test:live
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
