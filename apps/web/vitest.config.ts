// Vitest config for the web workspace.
//
// The Vue plugin is needed so component tests can import and mount .vue SFCs. Pure-logic
// tests default to the fast node environment; component tests opt into a DOM per file
// with `// @vitest-environment happy-dom` so we only pay for the DOM where it is used.
// All test tooling (vitest, @vue/test-utils, happy-dom) is a devDependency - no runtime
// dependency is added.
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
