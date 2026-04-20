# WorldConflictUpdate

Deployable conflict-event map prototype with a static frontend and serverless API routes.

## What changed

This project now has two ways to run:

- `Local prototype mode`: the existing PowerShell localhost server in [serve.ps1](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\serve.ps1)
- `Deployable app mode`: Cloudflare Pages static hosting plus Pages Functions in [functions](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\functions)

The frontend still calls:

- `/api/conflicts`
- `/api/events?conflict=...`

On Cloudflare Pages, those are now served by Pages Functions instead of the local PowerShell backend.

## Live-source strategy

The current free-source ingestion path uses `Google News RSS`, `GDELT DOC 2.0`, and a bundle of publisher RSS feeds.

- each launch conflict has its own RSS query and GDELT query
- publisher feeds currently include BBC World, Al Jazeera, The Guardian World, NPR World, France 24, DW News, and UN News
- Pages Functions map articles onto a conflict-specific location list
- exact markers are used when known cities or facilities are explicitly matched
- approximate markers are used when only broader regional language is found
- very old articles are filtered out before they become markers
- fallback cache data is returned if live fetches fail

This is free and deployable, but still heuristic. It is best thought of as a strong MVP, not a final intelligence-grade system.

## Launch scope

- `Russia-Ukraine`
- `Israel-Gaza`
- `Israel-Iran-USA`
- confidence `1-5`
- severity `1-5`
- exact and approximate markers
- automatic background refresh

## How To Deploy As A Real App

This is the easiest first-time path.

### 1. Put the code on GitHub

Create a GitHub repository and push this project to it.

### 2. Create a Cloudflare Pages project

Official docs:

- [Cloudflare Pages get started](https://developers.cloudflare.com/pages/get-started/)
- [Cloudflare Pages Functions get started](https://developers.cloudflare.com/pages/functions/get-started/)
- [Cloudflare static HTML deploy guide](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)

In Cloudflare:

1. Go to `Workers & Pages`
2. Click `Create application`
3. Choose `Pages`
4. Import your GitHub repo

Use these settings:

- Production branch: `main`
- Build command: `exit 0`
- Build output directory: `.`

Cloudflare’s static HTML guide says using `exit 0` is the recommended no-build command when you still want Pages Functions.

### 3. Deploy

Cloudflare will give you a URL like:

`https://your-project.pages.dev`

That URL is your real public app.

## Key deploy files

- [index.html](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\index.html): app shell
- [app.js](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\app.js): frontend logic
- [styles.css](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\styles.css): UI styling
- [functions/api/conflicts.js](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\functions\api\conflicts.js): deployable conflict config endpoint
- [functions/api/events.js](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\functions\api\events.js): deployable live event endpoint
- [wrangler.jsonc](C:\Users\William Millena\Documents\Codex\2026-04-20-lets-do-a-project-where-its\wrangler.jsonc): Cloudflare config

## After Deployment

Once the public site works, the next upgrades are:

1. mobile-first layout polish
2. installable PWA support
3. notification opt-ins
4. better location matching and event de-duplication
5. stronger structured conflict data alongside RSS

## PWA And Notifications Later

When you are ready to make it feel like a true app:

- [MDN Progressive Web Apps](https://developer.mozilla.org/docs/Web/Progressive_web_apps)
- [MDN Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)

That is the route for:

- home screen install
- standalone app feel
- push notifications
- better mobile behavior
