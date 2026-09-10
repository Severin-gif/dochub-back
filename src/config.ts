import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  ALLOW_DEMO_AUTH: z.string().default("false").transform((v) => v === "true"),
  DEMO_USER_EMAIL: z.string().email().default("demo@dochub.local"),
});

export const config = schema.parse(process.env);
export const allowedOrigins = config.CORS_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
