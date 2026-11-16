ALTER TABLE "dugout_game_result" DROP CONSTRAINT "game_result_game_fixture_uq";--> statement-breakpoint
ALTER TABLE "dugout_game" ADD COLUMN "season_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dugout_game_live_match" ADD COLUMN "season_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dugout_game_result" ADD COLUMN "season_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dugout_game_result" ADD CONSTRAINT "game_result_game_season_fixture_uq" UNIQUE("game_id","season_no","fixture_id");