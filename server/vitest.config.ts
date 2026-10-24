import { defineConfig } from 'vitest/config';

// Testler src/ dışında (test/) tutulur; böylece `tsc` derlemesi etkilenmez.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
