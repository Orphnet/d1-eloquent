export interface CacheInvalidationEvent {
  /** The database table name (e.g., "users", "posts") */
  table: string;
  /** The primary key value of the affected record */
  id: string;
  /** The type of write operation that occurred */
  action: "create" | "update" | "delete";
}

export interface CacheAdapter {
  /**
   * Called after a successful write operation.
   * Implement this to invalidate relevant cache entries.
   */
  invalidate(event: CacheInvalidationEvent): Promise<void>;
}
