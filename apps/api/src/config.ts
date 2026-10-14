import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated once at
 * startup. Two reasons this matters:
 *
 * 1. Fail fast: a typo in DATABASE_URL crashes immediately with a clear
 *    message instead of failing mysteriously on the first query.
 * 2. Deploy-ready: locally the values come from apps/api/.env; on a server
 *    they come from the host's settings. The code never changes.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(z.prettifyError(parsed.error));
  console.error('\nDid you copy apps/api/.env.example to apps/api/.env?');
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
