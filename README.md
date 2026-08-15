# ASRGH Cloudflare Backend Files

Copy these files into the existing `backened` folder, preserving paths.

Files:
- `src/app.ts`
- `src/server.ts`
- `src/worker.ts`
- `src/routes/photos.worker.ts`
- `wrangler.jsonc`
- `package.json`
- `tsconfig.json`

Do not replace:
- `.env`
- `prisma/`
- `src/config/prisma.ts`
- existing auth/member/event routes
- `src/routes/photos.ts` (this remains the localhost photo implementation)

Runtime behavior:
- `npm run dev` -> Node/Express localhost API + local disk photos.
- `npm run dev:worker` / `npm run deploy` -> Cloudflare Worker + R2 photos.
- R2 bucket remains private; media is served through `/media/...` on the Worker.

Production secrets still need to be added using Wrangler:
- `DATABASE_URL`
- `JWT_SECRET`

Production CORS must also be configured before deployment.
