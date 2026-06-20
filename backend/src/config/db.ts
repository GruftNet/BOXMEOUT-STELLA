import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://boxmeout:boxmeout@localhost:5432/boxmeout';

export const pool = new Pool({ connectionString: DATABASE_URL });
export const db = drizzle(pool, { schema });
