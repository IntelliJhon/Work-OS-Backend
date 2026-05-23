import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { env } from '../config/env';

// Register ws constructor for Node.js environments to enable stable WebSocket connection pooling
neonConfig.webSocketConstructor = ws;

// Highly stable Connection Pool with full transaction support
const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { logger: env.NODE_ENV === 'development' });
