import { defineConfig } from 'vitest/config';

// Logins respect GoTrue's per-number OTP spacing, so allow time for a retry.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
