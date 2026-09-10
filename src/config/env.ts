import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().url(),
  DATABASE_URL_DIRECT: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),
  JWT_ACCESS_EXPIRATION: z.string().default('15m'),
  JWT_REFRESH_EXPIRATION: z.string().default('7d'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CLOUDINARY_URL: z.string().url().optional(),
  GLOBAL_RATE_LIMIT_MAX: z.string().default('5000').transform(val => parseInt(val, 10)),
  AUTH_RATE_LIMIT_MAX: z.string().default('500').transform(val => parseInt(val, 10)),
  N8N_OPEN_POINT_WEBHOOK: z.string().optional().default(''),
  APP_URL: z.string().optional().default('http://localhost:5173'),
  AUTOMATIONS_BUILDER_API_BASE: z.string().optional().default('https://partner-api.automationsbuilder.com'),
  AUTOMATIONS_BUILDER_API_TOKEN: z.string().optional().default('ed30d865-61a9-4d02-9af8-e262cd9962d4'),
  CRON_SECRET: z.string().optional().default('workos_expiry_cron_secret_2026'),
  EXPIRY_ALERT_TEST_NUMBER: z.string().optional().default('7736956474'),
  CRM_API_ACCESS_TOKEN: z.string().optional().default('nN4nTt9OSg5MkY1MksuWT3VmMfTkMIYhSghRJcAREFTSAoetUtHWYNrleHTUXzEmsREFTSAEqnPgpf6OQ75GYg4oM3rXFE0bORedVU5ERVJTQ09SRQY56ho939eYgJz1H88zR855ikVU5ERVJTQ09SRQ6sVeIIw'),
  CRM_PHONE_NUMBER_ID: z.string().optional().default('810611068796796'),
  CRM_API_URL: z.string().optional().default('https://crmapi.waau.in/api/meta'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
