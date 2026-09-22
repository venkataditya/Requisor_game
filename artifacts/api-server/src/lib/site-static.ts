import fs from "fs";
import path from "path";
import express, { Router, type IRouter } from "express";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves the site's static build (artifacts/citrus-landing/dist/public, which also carries the
 * staged game previews under game-previews/<slug>/) from the API process, so one origin handles
 * the site, the customizer, the game previews and /api. Used in production when that directory
 * exists next to the bundle — the Render Docker image builds it there.
 *
 * Resolution order: a real file wins; then a known game's client-side routes fall back to that
 * game's own index.html (Boat Booth has /create); then anything that isn't /api falls back to the
 * site's index.html for the site's own client-side routes.
 */
export function createSiteRouter(siteDist: string, previewSlugs: readonly string[]): IRouter {
  const router: IRouter = Router();
  const siteIndex = path.join(siteDist, "index.html");
  const knownSlugs = new Set(previewSlugs);

  router.use(
    express.static(siteDist, {
      setHeaders(res, filePath) {
        // Vite writes content-hashed filenames under assets/ (site and every game): cache forever.
        if (path.relative(siteDist, filePath).split(path.sep).includes("assets")) {
          res.setHeader("Cache-Control", IMMUTABLE);
        }
      },
    }),
  );

  router.get("/game-previews/:slug/*splat", (req, res, next) => {
    const slug = firstParam(req.params.slug);
    if (!knownSlugs.has(slug)) return next();
    const gameIndex = path.join(siteDist, "game-previews", slug, "index.html");
    if (!fs.existsSync(gameIndex)) return next();
    res.sendFile(gameIndex);
  });

  router.get("/*splat", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    if (!fs.existsSync(siteIndex)) return next();
    res.sendFile(siteIndex);
  });

  return router;
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
