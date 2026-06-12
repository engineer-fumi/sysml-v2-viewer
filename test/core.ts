/**
 * Core regression tests (no VS Code required).
 *
 * Run with: npm run test:core
 *
 * - all bundled samples (hand-made + OMG official) parse and validate clean
 * - every diagram kind lays out without errors and with expected content
 * - manual layout features (inherited ports, relative edge routing,
 *   actor merging) keep working
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { createElement, qualifiedName, walk, SysMLElement } from "../src/core/ast";
import { DIAGRAM_KINDS, layoutDiagram, portOffsetKey } from "../src/core/layout";
import { parseSysML } from "../src/core/parser";
import { Resolver } from "../src/core/resolve";
import { STDLIB_FILES } from "../src/core/stdlib";
import { validateFile } from "../src/core/validate";

const SAMPLES_DIR = path.join(__dirname, "..", "samples");

function buildModel(): { root: SysMLElement; sampleFiles: { name: string; el: SysMLElement }[] } {
  const root = createElement("namespace");
  const add = (name: string, src: string): SysMLElement => {
    const r = parseSysML(src);
    assert.deepStrictEqual(
      r.errors.map((e) => `${name}: ${e.message}`),
      [],
      `parse errors in ${name}`
    );
    const el = r.root;
    el.kind = "file";
    el.name = name;
    el.parent = root;
    root.children.push(el);
    return el;
  };
  for (const lib of STDLIB_FILES) add(lib.name, lib.source);
  const sampleFiles: { name: string; el: SysMLElement }[] = [];
  const collect = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith(".sysml") || e.name.endsWith(".kerml")) {
        const name = path.relative(SAMPLES_DIR, p);
        sampleFiles.push({ name, el: add(name, fs.readFileSync(p, "utf8")) });
      }
    }
  };
  collect(SAMPLES_DIR);
  return { root, sampleFiles };
}

function find(root: SysMLElement, name: string, kind?: string): SysMLElement {
  let found: SysMLElement | undefined;
  walk(root, (el) => {
    if (!found && el.name === name && (!kind || el.kind === kind)) found = el;
  });
  assert.ok(found, `element ${name} (${kind ?? "any"}) not found`);
  return found!;
}

/** find by qualified name — sample names may collide across packages */
function findQ(root: SysMLElement, qualified: string): SysMLElement {
  let found: SysMLElement | undefined;
  walk(root, (el) => {
    if (!found && qualifiedName(el) === qualified) found = el;
  });
  assert.ok(found, `element ${qualified} not found`);
  return found!;
}

let passed = 0;
function test(title: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`PASS: ${title}`);
}

const { root, sampleFiles } = buildModel();

test("all samples validate clean", () => {
  const resolver = new Resolver(root);
  for (const f of sampleFiles) {
    const diags = validateFile(f.el, resolver);
    assert.deepStrictEqual(
      diags.map((d) => `${f.name}: [${d.rule}] ${d.message}`),
      [],
      `semantic diagnostics in ${f.name}`
    );
  }
  assert.ok(sampleFiles.length >= 17, `expected >= 17 sample files, got ${sampleFiles.length}`);
});

test("every diagram kind lays out the combined model", () => {
  for (const k of DIAGRAM_KINDS) {
    const l = layoutDiagram(root, { kind: k.id });
    assert.ok(l.nodes.length > 0, `${k.id}: no nodes`);
    assert.ok(Number.isFinite(l.width) && Number.isFinite(l.height), `${k.id}: bad extent`);
  }
});

test("ibd inherits ports from definitions and anchors connects on them", () => {
  const vehicle = findQ(root, "VehicleConfiguration::vehicle");
  const l = layoutDiagram(vehicle, { kind: "ibd" });
  const engine = l.nodes[0].children.find((n) => n.label === "engine");
  assert.ok(engine, "engine box");
  assert.deepStrictEqual(engine!.ports.map((p) => p.name).sort(), ["drive", "fuelIn"]);
  assert.ok(l.edges.some((e) => e.kind === "flow"), "fuel flow edge");
});

test("bdd derives composition from usage structure", () => {
  const l = layoutDiagram(root, { kind: "bdd" });
  const compose = l.edges.filter((e) => e.kind === "compose");
  const hasVehicleEngine = compose.some(
    (e) => e.a?.label === "Vehicle" && e.b?.label === "Engine"
  );
  assert.ok(hasVehicleEngine, "Vehicle ◆— Engine composition");
  // imports between rendered packages are drawn, nested pairs are not
  for (const e of l.edges.filter((x) => x.kind === "import")) {
    let nested = false;
    for (let cur = e.b!.el.parent; cur; cur = cur.parent) if (cur === e.a!.el) nested = true;
    assert.ok(!nested, "no parent->child import edges");
  }
});

test("use case view merges same-named actors into one figure", () => {
  const pkg = find(root, "RobotUseCases", "package");
  const l = layoutDiagram(pkg, { kind: "uc" });
  const actors = l.nodes.filter((n) => n.actor);
  assert.strictEqual(actors.length, 1, "one merged actor figure");
  assert.ok(l.edges.filter((e) => e.kind === "assoc").length >= 2, "actor associations");
  assert.ok(l.edges.filter((e) => e.kind === "perform").length >= 2, "perform edges");
  const boundary = l.nodes.find((n) => n.kindLabel === "subject");
  assert.ok(boundary, "subject boundary box");
});

test("sequence view shows parts and flows only", () => {
  const l = layoutDiagram(root, { kind: "seq" });
  assert.ok(l.nodes.every((n) => n.lifelineEnd !== undefined), "all nodes are lifelines");
  assert.ok(l.nodes.every((n) => n.el.kind !== "action"), "no action lifelines");
  assert.ok(l.edges.length >= 1, "at least one message");
});

test("relative edge waypoints follow the endpoint boxes", () => {
  const keyOf = (el: SysMLElement) => qualifiedName(el);
  const pkg = find(root, "OrderProcessing", "package");
  const base = layoutDiagram(pkg, { kind: "action", keyOf });
  const flow = base.edges.find((e) => e.kind === "flow");
  assert.ok(flow?.key, "flow edge with key");

  const offsets = { [flow!.key!]: { dx: 0, dy: 0, wp: [{ x: 40, y: 60 }], rel: true } };
  const routed = layoutDiagram(pkg, { kind: "action", keyOf, offsets });
  const e1 = routed.edges.find((e) => e.key === flow!.key)!;
  assert.strictEqual(e1.points?.length, 1);

  // move the source box: the waypoint must follow (stay at base+offset)
  const srcKey = keyOf(e1.a!.el);
  const moved = layoutDiagram(pkg, {
    kind: "action",
    keyOf,
    offsets: { ...offsets, [srcKey]: { dx: 200, dy: 120 } },
  });
  const e2 = moved.edges.find((e) => e.key === flow!.key)!;
  assert.notDeepStrictEqual(
    { x: e1.points![0].x, y: e1.points![0].y },
    { x: e2.points![0].x, y: e2.points![0].y },
    "waypoint should move with the boxes"
  );
});

test("manual port placement pins a port to a side", () => {
  const keyOf = (el: SysMLElement) => qualifiedName(el);
  const vehicle = findQ(root, "VehicleConfiguration::vehicle");
  const fuelTank = findQ(root, "VehicleConfiguration::vehicle::fuelTank");
  const fuelOut = findQ(root, "VehicleDefinitions::FuelTank::fuelOut");
  const key = portOffsetKey(keyOf, fuelTank, fuelOut);
  const l = layoutDiagram(vehicle, {
    kind: "ibd",
    keyOf,
    offsets: { [key]: { dx: 0, dy: 0, side: "right", t: 0.5 } },
  });
  const tank = l.nodes[0].children.find((n) => n.label === "fuelTank")!;
  const port = tank.ports.find((p) => p.name === "fuelOut")!;
  assert.strictEqual(port.side, "right");
  assert.ok(Math.abs(port.x - (tank.x + tank.w)) < 0.01, "port on the right border");
});

console.log(`ALL CORE TESTS PASSED (${passed})`);
