import { describe, it, expect } from "vitest";
import {
    EloquentException,
    ModelNotFoundException,
    MultipleRecordsFoundException,
} from "../exceptions";

describe("EloquentException", () => {
    it("is an instance of Error", () => {
        const err = new EloquentException("test");
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(EloquentException);
        expect(err.name).toBe("EloquentException");
        expect(err.message).toBe("test");
    });
});

describe("ModelNotFoundException", () => {
    it("includes model name and ID", () => {
        const err = new ModelNotFoundException("User", "abc-123");
        expect(err).toBeInstanceOf(EloquentException);
        expect(err.name).toBe("ModelNotFoundException");
        expect(err.model).toBe("User");
        expect(err.id).toBe("abc-123");
        expect(err.message).toContain("User");
        expect(err.message).toContain("abc-123");
    });

    it("works without ID", () => {
        const err = new ModelNotFoundException("Post");
        expect(err.model).toBe("Post");
        expect(err.id).toBeUndefined();
        expect(err.message).toContain("Post");
    });
});

describe("MultipleRecordsFoundException", () => {
    it("includes model name and count", () => {
        const err = new MultipleRecordsFoundException("User", 5);
        expect(err).toBeInstanceOf(EloquentException);
        expect(err.name).toBe("MultipleRecordsFoundException");
        expect(err.model).toBe("User");
        expect(err.count).toBe(5);
        expect(err.message).toContain("User");
        expect(err.message).toContain("5");
    });
});
