export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  PUBLIC_URL: string;
  ALLOWED_HOSTNAMES?: string;
  GITHUB_API_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  LOGIN_LIMIT?: RateLimit;
}
