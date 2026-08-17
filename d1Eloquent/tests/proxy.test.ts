// proxy.test.ts - Tests for Proxy wrapper via asProxy()

import { describe, it, expect } from "vitest";
import { BaseModel } from "../baseModel";
import { Attribute } from "../attribute";

// ─── Test Model ───

interface UserAttrs {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  created_at?: string | Date;
  updated_at?: string | Date;
}

interface UserVirtuals {
  full_name: string;
}

class UserModel extends BaseModel<UserAttrs, UserVirtuals> {
  static table = "users";
  static timestamps = false;

  static accessors = {
    full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
      return `${attrs.first_name ?? ""} ${attrs.last_name ?? ""}`.trim();
    }),
    email: Attribute.make({
      get: (value: unknown) => String(value ?? "").toLowerCase(),
      set: (value: unknown) => String(value ?? "").toLowerCase(),
    }),
  };

  static appends = ["full_name"];
}

// ─── PROXY-01: get trap ───

describe("Proxy - get trap", () => {
  it("proxy.first_name returns same as model.get('first_name') for real attr", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith", email: "alice@example.com" });
    const proxy = model.asProxy();

    expect(proxy.first_name).toBe(model.get("first_name"));
    expect(proxy.first_name).toBe("Alice");
  });

  it("proxy.full_name resolves virtual accessor (same as model.get('full_name'))", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith" });
    const proxy = model.asProxy();

    expect(proxy.full_name).toBe("Alice Smith");
    expect(proxy.full_name).toBe(model.get("full_name" as keyof UserAttrs));
  });

  it("proxy.unknownKey returns undefined", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    expect((proxy as any).nonExistentKey).toBeUndefined();
  });

  it("proxy.$model returns the underlying model instance", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    expect(proxy.$model).toBe(model);
  });

  it("proxy.save is a function (method passthrough)", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    expect(typeof proxy.save).toBe("function");
  });

  it("proxy.toObject is a function that returns correct shape", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith" });
    const proxy = model.asProxy();

    expect(typeof proxy.toObject).toBe("function");
    expect(proxy.toObject()).toEqual(model.toObject());
  });
});

// ─── PROXY-02: set trap ───

describe("Proxy - set trap", () => {
  it("proxy.email = 'NEW@X.COM' triggers mutator (lowercases)", () => {
    const model = new UserModel({ id: "1", email: "original@example.com" });
    const proxy = model.asProxy();

    proxy.email = "NEW@X.COM" as any;

    expect(proxy.email).toBe("new@x.com");
    expect(model.get("email")).toBe("new@x.com");
  });

  it("proxy.first_name = 'Bob' updates attr, model.get reflects change", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    proxy.first_name = "Bob";

    expect(proxy.first_name).toBe("Bob");
    expect(model.get("first_name")).toBe("Bob");
  });

  it("setting triggers fan-out mutator when defined", () => {
    interface FanAttrs {
      id?: string;
      first_name?: string;
      last_name?: string;
    }

    class FanModel extends BaseModel<FanAttrs> {
      static table = "fan_test";
      static timestamps = false;
      static accessors = {
        name: Attribute.set((value: unknown) => {
          const parts = String(value).split(" ");
          return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
        }),
      };
    }

    const model = new FanModel({ id: "1", first_name: "Alice", last_name: "Smith" });
    const proxy = model.asProxy();

    (proxy as any).name = "Bob Jones";

    expect(proxy.first_name).toBe("Bob");
    expect(proxy.last_name).toBe("Jones");
  });
});

// ─── PROXY-03: JSON + instanceof ───

describe("Proxy - JSON and instanceof", () => {
  it("JSON.stringify(proxy) === JSON.stringify(model.toObject())", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith", email: "alice@example.com" });
    const proxy = model.asProxy();

    expect(JSON.stringify(proxy)).toBe(JSON.stringify(model.toObject()));
  });

  it("proxy instanceof UserModel returns true", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    expect(proxy instanceof UserModel).toBe(true);
  });

  it("proxy instanceof BaseModel returns true", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    expect(proxy instanceof BaseModel).toBe(true);
  });
});

// ─── Enumeration ───

describe("Proxy - enumeration", () => {
  it("Object.keys(proxy) returns attr keys + appended virtuals", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith" });
    const proxy = model.asProxy();

    const keys = Object.keys(proxy);
    expect(keys).toContain("id");
    expect(keys).toContain("first_name");
    expect(keys).toContain("last_name");
    expect(keys).toContain("full_name"); // appended virtual
  });

  it("'first_name' in proxy returns true (attr key)", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });
    const proxy = model.asProxy();

    expect("first_name" in proxy).toBe(true);
  });

  it("'full_name' in proxy returns true (appended virtual)", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith" });
    const proxy = model.asProxy();

    expect("full_name" in proxy).toBe(true);
  });

  it("'save' in proxy returns false (method)", () => {
    const model = new UserModel({ id: "1" });
    const proxy = model.asProxy();

    expect("save" in proxy).toBe(false);
  });

  it("{ ...proxy } produces same shape as toObject()", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith", email: "alice@test.com" });
    const proxy = model.asProxy();

    const spread = { ...proxy };
    expect(spread).toEqual(model.toObject());
  });
});

// ─── Caching ───

describe("Proxy - caching", () => {
  it("asProxy() returns same proxy on second call (referential equality)", () => {
    const model = new UserModel({ id: "1", first_name: "Alice" });

    const proxy1 = model.asProxy();
    const proxy2 = model.asProxy();

    expect(proxy1).toBe(proxy2);
  });
});

// ─── TVirtuals typing (compile-time check) ───

describe("Proxy - TVirtuals typing", () => {
  it("proxy return type allows proxy.full_name without type error when TVirtuals defined", () => {
    const model = new UserModel({ id: "1", first_name: "Alice", last_name: "Smith" });
    const proxy = model.asProxy();

    // This line should compile without error thanks to TVirtuals
    const fullName: string = proxy.full_name;
    expect(fullName).toBe("Alice Smith");
  });
});
