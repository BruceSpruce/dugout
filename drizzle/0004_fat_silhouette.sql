CREATE TABLE "dugout_game_lineup" (
	"game_id" integer PRIMARY KEY NOT NULL,
	"formation" text NOT NULL,
	"style" text NOT NULL,
	"starters" jsonb NOT NULL,
	"bench" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dugout_game_lineup" ADD CONSTRAINT "dugout_game_lineup_game_id_dugout_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."dugout_game"("id") ON DELETE cascade ON UPDATE no action;