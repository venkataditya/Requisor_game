import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createSiteRouter } from "./site-static";

describe("createSiteRouter", () => {
  let tmp: string;
  let base: string;
  let server: ReturnType<express.Express["listen"]>;

  function write(rel: string, body: string): void {
    const file = path.join(tmp, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "site-static-"));
    write("index.html", "SITE");
    write("assets/app-abc123.js", "console.log('site')");
    write("game-previews/boat-booth/index.html", "BOAT");
    write("game-previews/boat-booth/assets/g-def456.js", "console.log('boat')");
    write("game-previews/boat-booth/media/clip.mp4", "mp4");

    const app = express();
    app.get("/api/healthz", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.use(createSiteRouter(tmp, ["boat-booth"]));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("serves the site index at the root", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "SITE");
  });

  it("serves hashed site assets with an immutable cache header", async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  });

  it("serves staged game assets with an immutable cache header", async () => {
    const res = await fetch(`${base}/game-previews/boat-booth/assets/g-def456.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  });

  it("does not mark unhashed game media immutable", async () => {
    const res = await fetch(`${base}/game-previews/boat-booth/media/clip.mp4`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers.get("cache-control") ?? "", /immutable/);
  });

  it("serves a game's own index at its base path", async () => {
    const res = await fetch(`${base}/game-previews/boat-booth/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "BOAT");
  });

  it("falls back to the site index for the site's client-side routes", async () => {
    const res = await fetch(`${base}/games`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "SITE");
    assert.doesNotMatch(res.headers.get("cache-control") ?? "", /immutable/);
  });

  it("falls back to a known game's own index for that game's client-side routes", async () => {
    const res = await fetch(`${base}/game-previews/boat-booth/create`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "BOAT");
  });

  it("falls back to the site index for an unknown game slug", async () => {
    const res = await fetch(`${base}/game-previews/not-a-game/create`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "SITE");
  });

  it("never swallows unmatched /api paths", async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.notEqual(await res.text(), "SITE");
  });
});
