import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { env } from '../config/env';

// Highly stable HTTP client for serverless and containerized production
const sql = neon(env.DATABASE_URL);
export const db = drizzle(sql);

