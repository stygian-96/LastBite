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
  // Fixed test-only secrets (ENCRYPTION_KEY is 32 bytes, base64).
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
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
