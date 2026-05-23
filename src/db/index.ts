import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
import { env } from '../config/env';

// Pool for the application (standard connection)
const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzleServerless(pool, { logger: env.NODE_ENV === 'development' });

// Non-pooling HTTP client for specific cases if needed
const sql = neon(env.DATABASE_URL);
export const httpDb = drizzle(sql);
