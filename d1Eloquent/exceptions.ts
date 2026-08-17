/**
 * Base exception for all d1-eloquent errors.
 */
export class EloquentException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EloquentException";
    }
}

/**
 * Thrown when a model lookup (findOrFail, firstOrFail, sole) returns no results.
 */
export class ModelNotFoundException extends EloquentException {
    public readonly model: string;
    public readonly id?: string;

    constructor(model: string, id?: string) {
        const msg = id
            ? `No query results for model [${model}] with ID [${id}].`
            : `No query results for model [${model}].`;
        super(msg);
        this.name = "ModelNotFoundException";
        this.model = model;
        this.id = id;
    }
}

/**
 * Thrown when sole() finds more than one matching record.
 */
export class MultipleRecordsFoundException extends EloquentException {
    public readonly model: string;
    public readonly count: number;

    constructor(model: string, count: number) {
        super(`Expected exactly one result for model [${model}], but found ${count}.`);
        this.name = "MultipleRecordsFoundException";
        this.model = model;
        this.count = count;
    }
}
