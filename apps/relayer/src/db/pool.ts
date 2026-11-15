import { Pool } from "pg";
import { env } from "../config";

export const pool = new Pool({ connectionString: env.databaseUrl, max: 4 });
