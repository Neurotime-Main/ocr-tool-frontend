# Markwise web

Standalone React + Vite frontend for the Markwise OCR highlighter. This repository contains no backend, database credentials, or AWS credentials.

The upload screen accepts one or up to 30 PDFs. The workspace searches all completed documents together, groups mentions by PDF and page, jumps directly to a selected highlight, and exports an Excel findings report in addition to highlighted PDFs. English, Azerbaijani, mixed-language OCR, and force-OCR for decorated layouts are supported.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

Set `VITE_API_URL` to the public backend API URL, including `/api` and without a trailing slash.

## Deploy to Vercel

1. Push this `frontend` directory as its own Git repository.
2. Import it in Vercel. Vercel detects Vite; `vercel.json` also declares the build and output settings.
3. Add `VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com/api` to Production and Preview environments.
4. Deploy, then add the resulting Vercel origin to the backend's `CLIENT_ORIGIN` value.

Vite injects `VITE_*` variables during the build, so redeploy after changing the API URL.

## Commands

```bash
npm run dev
npm run typecheck
npm run build
```
