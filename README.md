# Dugout

A single-player football manager game that runs on your own machine. You take over a club from a real league season, pick the lineup and tactics, play every matchday minute by minute with live commentary and substitutions, and carry your squad from one season into the next.

The game is available in English and Polish (switch in the top-right corner).

## Features

- New game: pick any club from a loaded league season.
- Round screen: next fixture, league table, results of the previous round.
- Lineup and tactics: formation, style, AI-suggested lineup, injuries and suspensions.
- Live matchday: minute-by-minute commentary, substitutions and tactic changes, other matches of the round simulated alongside.
- Leave at any moment and resume later; an abandoned match is finished by the AI.
- Season summary, history of all seasons and an all-time table; the next season starts after round 38.
- Match engine calibrated against real league statistics (goals per match, home wins, draws), with a batch calibration report.

## Requirements

- Node.js 20+ and npm
- Docker (for the local PostgreSQL 18 database)
- An [API-Football](https://www.api-football.com/) key (the free plan is enough; it allows 100 requests per day)

## Setup

```bash
cp .env.example .env              # set API_FOOTBALL_KEY; DATABASE_URL works with the script below
./start-database.sh               # starts the dugout-postgres container
npm install
npm run db:migrate
npm run import:season -- --league 39 --season 2024
npm run dev                       # http://localhost:3000
```

A full league season needs more requests than the free daily quota. `import:season` stops with exit code 2 when the budget runs out. Run it again the next day and it continues where it stopped.

### Daily download (optional, Linux)

`scripts/league-queue.json` lists leagues to download one after another with each day's quota. On Linux you can install a systemd user timer that runs the download every day just after the quota resets:

```bash
npm run daily:install                       # installs and starts the timer
journalctl --user -u dugout-daily-fetch     # logs
```

You can also run it by hand: `npm run daily:fetch`.

## Commands

| Command                                                   | What it does                                           |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `npm run dev`                                             | Development server                                     |
| `npm run build` / `npm start`                             | Production build and server                            |
| `npm run import:season -- --league <id> --season <year>`  | Download, load and check one league season             |
| `npm run import:fetch` / `import:load` / `import:report`  | The same import, stage by stage                        |
| `npm run calibration:report -- --league 39 --season 2024` | Simulated seasons compared with real league statistics |
| `npm run attributes:report -- --league 39 --season 2024`  | Player attributes and club strength                    |
| `npm run db:generate` then `npm run db:migrate`           | Schema changes (SQL migrations in `drizzle/`)          |

## Tests and checks

```bash
npm test             # Vitest, no network or database needed
npm run typecheck
npm run check        # Biome lint and format
npm run build
```

## Stack

Next.js 15 (App Router), tRPC 11, Drizzle ORM, PostgreSQL 18, Tailwind CSS 4, next-intl, Biome and Vitest. The match and season engine in `src/engine/` is plain TypeScript with no framework imports, so it also runs from the command line for batch calibration.

## Data

Club, player and fixture data come from API-Football and are **not** included in this repository. Everyone downloads them with their own key into the local `.data/` folder and database, under API-Football's terms of use. The test fixtures in `src/import/api-football/__fixtures__/` are invented and only mimic the shape of API responses.

This is a fan project, not affiliated with any league, club or data provider.

## License

[MIT](LICENSE)
