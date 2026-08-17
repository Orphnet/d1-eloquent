// src/cli-exports.ts - Subpath export for @orphnet/d1-eloquent/cli

// Schema builder for migrations
export {
  Schema,
  VirtualTableBuilder,
  BaseColumnBuilder,
  ColumnBuilder,
  AlterColumnBuilder,
  type FKAction,
  type TGeneratedMode,
  type TFts5Options,
  type TCreateTableOpts,
  type TTimestampsOpts,
} from "../scripts/schema";

// Factory base class for generated factories
export { Factory, type TCreateOpts } from "../scripts/factory";

// Direct D1 query execution for advanced seeders
export { d1Execute, D1ExecuteError } from "../scripts/d1Execute";

// Lightweight faker for seed data generation
export { fake, Fake, formatDate, type TDateOpts } from "../scripts/fake";

// Structured console output for seeders
export {
  output, SeederOutput,
  type TCardRow, type TLogOpts,
  type TProgressTracker, type TProgressOpts,
  type TProgressBarTracker, type TProgressBarOpts,
  type TCounterTracker, type TCounterOpts,
  type TTimerHandle,
  type TGroupDef, type TGroupResult,
  type TSeederResult, type TRunSeedersOpts,
} from "../scripts/seederOutput";

// Types needed by generated migration/seeder files
export type { TMigration, TSeeder, TSeederOpts, TD1JsonResult } from "../scripts/types";
