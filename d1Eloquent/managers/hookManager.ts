import type { THooks, THookEvent, THookHandler } from "../hookTypes";

/**
 * Manages lifecycle hook dispatch for model instances.
 */
export const HookManager = {
    /**
     * Run lifecycle hook(s) for the given event.
     * Returns `false` if any "before" hook explicitly returned `false` (cancel signal).
     */
    async fireHook<T>(model: T, event: THookEvent): Promise<boolean> {
        const ctor = (model as any).constructor as { hooks?: THooks<T> };
        const hooks = ctor.hooks;
        if (!hooks) return true;

        const handler = hooks[event];
        if (!handler) return true;

        const handlers: THookHandler<T>[] = Array.isArray(handler) ? handler : [handler];
        for (const fn of handlers) {
            const result = await fn(model);
            if (result === false) return false;
        }
        return true;
    },
};
