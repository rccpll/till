export interface Env {
  DB: D1Database;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  /** Tests only: JSON JWKS used instead of the remote Access certs. Never set in production. */
  CF_ACCESS_JWKS?: string;
}
