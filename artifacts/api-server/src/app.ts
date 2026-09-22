import fs from "fs";
import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import router from "./routes";
import gamePreviewsRouter, { GAME_PREVIEW_SLUGS, repoRoot } from "./lib/game-previews";
import { createSiteRouter } from "./lib/site-static";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Branding drafts carry uploaded logos/backgrounds as base64 data URIs in the
// JSON body — express's 100kb default silently 413s anything past a tiny
// image, so raise it enough to cover a real (if modest) video upload.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(gamePreviewsRouter);
app.use("/api", router);

// Production only: when the site's static build sits next to this bundle (the Render Docker image
// puts it there), serve it from this process too — site, customizer and staged game previews — so
// a single origin handles everything. Without the directory (Railway builds only the API; local
// dev serves the site from Vite) nothing changes.
const siteDist = path.resolve(repoRoot, "artifacts/citrus-landing/dist/public");
if (process.env.NODE_ENV === "production" && fs.existsSync(siteDist)) {
  app.use(createSiteRouter(siteDist, GAME_PREVIEW_SLUGS));
  logger.info({ siteDist }, "Serving the static site from api-server");
}

export default app;
