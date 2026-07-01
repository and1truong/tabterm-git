import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { subtreeMigrations } from "./subtreeMigrations.ts";
import { makeSubtreeDb } from "./subtreeDb.ts";
import { makeSubtreeService } from "./subtreeService.ts";

// Fake sync captures effects as inspectable tagged objects.
const sync = {
  set: (entity: string, data: unknown) => ({ kind: "set", entity, data }),
  del: (entity: string, id: string) => ({ kind: "del", entity, id }),
};

function freshDb() {
  const db = new Database(":memory:");
  for (const m of subtreeMigrations) m.up(db);
  return db;
}

function freshSvc() {
  const db = freshDb();
  const sdb = makeSubtreeDb(db);
  const service = makeSubtreeService(sdb, sync as any);
  return { sdb, service };
}

// --- subtreeDb CRUD round-trip ---

test("create → list shows the row", () => {
  const sdb = makeSubtreeDb(freshDb());
  sdb.create("s1", "tab1", "vendor/lib", "https://example.com/lib.git", "main", true);
  const rows = sdb.list("tab1");
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe("s1");
  expect(rows[0].prefix).toBe("vendor/lib");
  expect(rows[0].squash).toBe(true);
});

test("list without filter returns all rows", () => {
  const sdb = makeSubtreeDb(freshDb());
  sdb.create("s1", "tab1", "vendor/a", "https://example.com/a.git", "main", false);
  sdb.create("s2", "tab2", "vendor/b", "https://example.com/b.git", "dev", true);
  expect(sdb.list()).toHaveLength(2);
});

test("get returns the row or null", () => {
  const sdb = makeSubtreeDb(freshDb());
  sdb.create("s1", "tab1", "vendor/lib", "https://example.com/lib.git", "main", true);
  expect(sdb.get("s1")).not.toBeNull();
  expect(sdb.get("missing")).toBeNull();
});

test("update changes a field and squash boolean coercion works", () => {
  const sdb = makeSubtreeDb(freshDb());
  sdb.create("s1", "tab1", "vendor/lib", "https://example.com/lib.git", "main", false);
  const updated = sdb.update("s1", { branch: "release", squash: true });
  expect(updated).not.toBeNull();
  expect(updated!.branch).toBe("release");
  expect(updated!.squash).toBe(true); // boolean, not raw 0/1
});

test("update of missing id returns null", () => {
  const sdb = makeSubtreeDb(freshDb());
  const r = sdb.update("nope", { branch: "x" });
  expect(r).toBeNull();
});

test("delete removes the row (list empty, get null)", () => {
  const sdb = makeSubtreeDb(freshDb());
  sdb.create("s1", "tab1", "vendor/lib", "https://example.com/lib.git", "main", true);
  const ok = sdb.delete("s1");
  expect(ok).toBe(true);
  expect(sdb.list("tab1")).toHaveLength(0);
  expect(sdb.get("s1")).toBeNull();
});

test("delete of missing id returns false", () => {
  const sdb = makeSubtreeDb(freshDb());
  expect(sdb.delete("nope")).toBe(false);
});

// --- subtreeService effect shapes ---

test("gitSubtree:create returns exactly one set('gitSubtrees') effect", () => {
  const { service } = freshSvc();
  const effs = service.handle({
    type: "gitSubtree:create",
    id: "s1",
    primaryTabId: "tab1",
    prefix: "vendor/lib",
    remoteUrl: "https://example.com/lib.git",
    branch: "main",
    squash: true,
  }) as any[];
  expect(effs).toHaveLength(1);
  expect(effs[0].kind).toBe("set");
  expect(effs[0].entity).toBe("gitSubtrees");
  expect((effs[0].data as any).id).toBe("s1");
});

test("gitSubtree:update on existing row returns one set effect", () => {
  const { sdb, service } = freshSvc();
  sdb.create("s1", "tab1", "vendor/lib", "https://example.com/lib.git", "main", false);
  const effs = service.handle({
    type: "gitSubtree:update",
    subtreeId: "s1",
    branch: "release",
  }) as any[];
  expect(effs).toHaveLength(1);
  expect(effs[0].kind).toBe("set");
  expect(effs[0].entity).toBe("gitSubtrees");
});

test("gitSubtree:update on missing id returns []", () => {
  const { service } = freshSvc();
  const effs = service.handle({ type: "gitSubtree:update", subtreeId: "nope" });
  expect(effs).toHaveLength(0);
});

test("gitSubtree:delete after create returns one del('gitSubtrees') effect with right id", () => {
  const { sdb, service } = freshSvc();
  sdb.create("s1", "tab1", "vendor/lib", "https://example.com/lib.git", "main", true);
  const effs = service.handle({ type: "gitSubtree:delete", subtreeId: "s1" }) as any[];
  expect(effs).toHaveLength(1);
  expect(effs[0].kind).toBe("del");
  expect(effs[0].entity).toBe("gitSubtrees");
  expect(effs[0].id).toBe("s1");
});

test("gitSubtree:delete on missing id returns []", () => {
  const { service } = freshSvc();
  const effs = service.handle({ type: "gitSubtree:delete", subtreeId: "nope" });
  expect(effs).toHaveLength(0);
});

test("unknown message type returns []", () => {
  const { service } = freshSvc();
  expect(service.handle({ type: "gitSubtree:unknown" })).toHaveLength(0);
});
