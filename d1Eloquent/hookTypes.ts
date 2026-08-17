/**
 * Model lifecycle hook types.
 *
 * "Before" hooks (creating, updating, saving, deleting) can return `false`
 * to cancel the operation. All other return values (including void) proceed.
 *
 * "After" hooks (created, updated, saved, deleted) run after the DB write
 * and cannot cancel the operation.
 */

export type THookEvent =
    | "creating" | "created"
    | "updating" | "updated"
    | "saving"   | "saved"
    | "deleting"  | "deleted";

export type THookHandler<TModel> = (model: TModel) => void | false | Promise<void | false>;

export type THooks<TModel> = Partial<Record<THookEvent, THookHandler<TModel> | THookHandler<TModel>[]>>;
