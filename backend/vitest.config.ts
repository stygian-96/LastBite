import { defineConfig } from 'vitest/config';

// Tests run against the test database, never the dev one.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on variables already in the environment.
}
const testEnv = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
};
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: testEnv,
    globalSetup: ['tests/global-setup.ts'],
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
  },
});
