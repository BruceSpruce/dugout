CREATE TABLE "dugout_game_live_match" (
	"game_id" integer PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"round" integer NOT NULL,
	"seed" integer NOT NULL,
	"setup" jsonb NOT NULL,
	"background" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"minute" integer NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dugout_game_player_state" (
	"game_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"fitness" real NOT NULL,
	"form" real NOT NULL,
	"yellow_count" integer NOT NULL,
	"suspended_for" integer NOT NULL,
	"injured_for" integer NOT NULL,
	CONSTRAINT "dugout_game_player_state_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "dugout_game_live_match" ADD CONSTRAINT "dugout_game_live_match_game_id_dugout_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."dugout_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dugout_game_live_match" ADD CONSTRAINT "dugout_game_live_match_fixture_id_dugout_fixture_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."dugout_fixture"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dugout_game_player_state" ADD CONSTRAINT "dugout_game_player_state_game_id_dugout_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."dugout_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dugout_game_player_state" ADD CONSTRAINT "dugout_game_player_state_player_id_dugout_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."dugout_player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_live_match_fixture_idx" ON "dugout_game_live_match" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "game_player_state_player_idx" ON "dugout_game_player_state" USING btree ("player_id");