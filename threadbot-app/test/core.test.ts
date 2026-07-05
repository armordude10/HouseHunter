import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFingerprint, computeOrderHash } from "../src/core/hash.js";
import { artRectInBaseImage, fitArtToPrintArea } from "../src/core/position.js";
import { buildNeutralOrder } from "../src/core/orderMapper.js";
import type { DesignSpec, Placement, PlacementGeometry } from "../src/core/designSpec.js";

function placement(over: Partial<Placement> = {}): Placement {
  return {
    name: "front",
    technique: "dtg",
    fileUrl: "https://cdn.example.com/art-abc.png",
    fileSha256: "abc",
    position: { area_width: 1800, area_height: 2400, width: 1800, height: 1800, top: 300, left: 0 },
    options: [],
    mustRender: true,
    ...over,
  };
}

function spec(over: Partial<DesignSpec> = {}): DesignSpec {
  return {
    id: "d1",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "a fox",
    hasImageInput: false,
    provider: "printful",
    neutralProductId: "tee-classic",
    providerBinding: { providerProductId: 71, providerVariantId: 4012 },
    color: "Black",
    size: "UNRESOLVED",
    placements: [placement()],
    geometryVersion: "printful:templates:2026-01-01",
    previewImageUrl: "https://cdn.example.com/preview.jpg",
    policy: { status: "allow" },
    orderHash: "",
    ...over,
  };
}

const fp = (s: DesignSpec) =>
  computeOrderHash({
    provider: s.provider,
    providerBinding: { providerProductId: s.providerBinding.providerProductId },
    color: s.color,
    placements: s.placements,
  });

test("fitArtToPrintArea matches Printful's documented sample position", () => {
  // Square art into an 1800x2400 area -> 1800x1800 centered, top=300 (the collection example).
  assert.deepEqual(fitArtToPrintArea(1024, 1024, 1800, 2400), {
    area_width: 1800,
    area_height: 2400,
    width: 1800,
    height: 1800,
    top: 300,
    left: 0,
  });
});

test("order hash is independent of array ordering", () => {
  const a = spec({
    placements: [
      placement({ name: "front", options: [{ id: "b", value: 1 }, { id: "a", value: 2 }] }),
      placement({ name: "back", fileSha256: "def" }),
    ],
  });
  const b = spec({
    placements: [
      placement({ name: "back", fileSha256: "def" }),
      placement({ name: "front", options: [{ id: "a", value: 2 }, { id: "b", value: 1 }] }),
    ],
  });
  assert.equal(fp(a), fp(b));
});

test("order hash EXCLUDES size (late binding is safe)", () => {
  assert.equal(fp(spec({ size: "UNRESOLVED" })), fp(spec({ size: "XL" })));
});

test("order hash EXCLUDES the bound variant id", () => {
  const a = spec({ providerBinding: { providerProductId: 71, providerVariantId: 4012 } });
  const b = spec({ providerBinding: { providerProductId: 71, providerVariantId: 9999 } });
  assert.equal(fp(a), fp(b));
});

test("order hash CHANGES when the art or its position changes", () => {
  const base = spec();
  assert.notEqual(fp(base), fp(spec({ placements: [placement({ fileSha256: "TAMPERED" })] })));
  assert.notEqual(
    fp(base),
    fp(spec({ placements: [placement({ position: { ...placement().position, left: 50 } })] }))
  );
});

test("buildNeutralOrder copies files verbatim and carries the bound variant", () => {
  const s = spec();
  const order = buildNeutralOrder({
    spec: s,
    recipient: { name: "A", address1: "1 St", city: "LA", country_code: "US", zip: "90001" },
    boundVariantId: 4017,
    quantity: 2,
    externalId: "sess_123",
  });
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].providerVariantId, 4017);
  assert.equal(order.items[0].quantity, 2);
  assert.deepEqual(order.items[0].files[0], {
    type: "front",
    url: s.placements[0].fileUrl,
    position: s.placements[0].position,
    options: s.placements[0].options,
  });
});

test("buildNeutralOrder omits non-rendered placements", () => {
  const s = spec({ placements: [placement(), placement({ name: "back", mustRender: false })] });
  const order = buildNeutralOrder({
    spec: s,
    recipient: { name: "A", address1: "1 St", city: "LA", country_code: "US", zip: "90001" },
    boundVariantId: 4012,
    quantity: 1,
    externalId: "sess_x",
  });
  assert.equal(order.items[0].files.length, 1);
  assert.equal(order.items[0].files[0].type, "front");
});

test("artRectInBaseImage maps the print area when spaces line up 1:1", () => {
  const geometry: PlacementGeometry = {
    placement: "front",
    technique: "dtg",
    baseImageUrl: "x",
    templateWidth: 1000,
    templateHeight: 1200,
    printAreaWidth: 600,
    printAreaHeight: 800,
    printAreaTop: 100,
    printAreaLeft: 200,
  };
  // position area == print area, base image == template size -> rect == print area box.
  const rect = artRectInBaseImage(
    { area_width: 600, area_height: 800, width: 600, height: 800, top: 0, left: 0 },
    geometry,
    1000,
    1200
  );
  assert.deepEqual(rect, { left: 200, top: 100, width: 600, height: 800 });
});

test("buildFingerprint sorts placements by name", () => {
  const f = buildFingerprint({
    provider: "printful",
    providerBinding: { providerProductId: 71 },
    color: "Black",
    placements: [placement({ name: "back", fileSha256: "z" }), placement({ name: "front" })],
  });
  assert.deepEqual(
    f.placements.map((p) => p.name),
    ["back", "front"]
  );
});
