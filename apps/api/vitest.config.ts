import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Интеграционные тесты пишут в одну БД: без параллелизма файлов.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
