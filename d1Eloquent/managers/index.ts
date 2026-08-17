// Internal manager modules — not exported from the public package API.
// These are used by BaseModel to delegate behavior.

export { DirtyManager } from "./dirtyManager";
export type { TDirtyModel } from "./dirtyManager";

export { TimestampManager } from "./timestampManager";
export type { TTimestampModel } from "./timestampManager";

export { KeyManager } from "./keyManager";
export type { TKeyModel } from "./keyManager";

export { HookManager } from "./hookManager";
export type { THookModel } from "./hookManager";

export { SoftDeleteManager } from "./softDeleteManager";
export type { TSoftDeleteModel } from "./softDeleteManager";

export { RelationManager } from "./relationManager";
export type { TRelationalModel } from "./relationManager";

export { PersistenceManager } from "./persistenceManager";
