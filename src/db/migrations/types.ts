export interface Migration {
  /** Positive, strictly increasing integer. */
  version: number;
  name: string;
  /** Forward-only DDL. Never edited after it has been applied anywhere. */
  sql: string;
}
