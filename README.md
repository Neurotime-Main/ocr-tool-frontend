# Markwise web

Standalone React + Vite frontend for Markwise OCR. It has two workflows: Media monitoring reads prepared Neurotime keywords, finds and reviews mentions, and publishes approved results; Extract text accepts documents, images, and videos and returns plain text without writing monitoring records.

The upload screen accepts one or up to 30 PDFs, office files, images, or videos. Images are read directly, videos are read as one image per second, PDFs use reliable embedded text or page OCR, and office files preserve their layout as PDF pages. The monitoring workspace searches completed files together, groups mentions by file and page, and writes results only after Publish is confirmed. The extraction workspace offers copyable and downloadable text without monitoring database writes; its timer measures upload-to-text duration and video output is organized by timestamp. Azerbaijani, English, Russian, Uzbek, Turkish, mixed-language OCR, and force-OCR for complex layouts are supported.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

Set `VITE_API_URL` to the public backend API URL, including `/api` and without a trailing slash.

## Deploy to Vercel

1. Push this `frontend` directory as its own Git repository.
2. Import it in Vercel. Vercel detects Vite; `vercel.json` also declares the build, output directory, the SPA rewrite, and immutable caching for hashed assets.
3. Add the environment variable below to **Production, Preview, and Development**.
4. Deploy, then add the resulting Vercel origins to the backend's `CLIENT_ORIGIN` and redeploy the API.

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | `https://YOUR-RENDER-SERVICE.onrender.com/api` |

Include `/api`, and no trailing slash.

Vite inlines `VITE_*` at build time, so a changed API URL needs a **redeploy**, not a restart. A Vercel environment variable overrides a committed `.env`, and `.env` is git-ignored here anyway — copy `.env.example` for local work.

Preview deployments get a new hostname per branch. Give the backend a wildcard so they are not blocked by CORS:

```
CLIENT_ORIGIN=https://markwise.vercel.app,https://markwise-*.vercel.app
```

If a request fails with a CORS error in the browser, the API returned `403` because the origin was not in that list.

## Commands

```bash
npm run dev
npm run typecheck
npm run build
```
