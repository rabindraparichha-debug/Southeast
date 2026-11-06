import { defineConfig } from 'vitest/config';

// Logins respect GoTrue's per-number OTP spacing, so allow time for a retry.
// global-setup.ts resets the customer_whatsapp flag after the run (suites driving the bot switch it on).
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000, globalSetup: ['./global-setup.ts'] } });
