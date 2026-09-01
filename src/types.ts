export interface Bindings {
  DB: D1Database;
  ADMIN_KEY: string;
}

export interface AppEnv {
  Bindings: Bindings;
}
