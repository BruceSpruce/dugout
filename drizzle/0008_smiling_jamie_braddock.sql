ALTER TABLE "dugout_club" ALTER COLUMN "api_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dugout_fixture" ALTER COLUMN "api_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dugout_club" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "dugout_fixture" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "dugout_club" ADD CONSTRAINT "dugout_club_source_key_unique" UNIQUE("source_key");--> statement-breakpoint
ALTER TABLE "dugout_fixture" ADD CONSTRAINT "dugout_fixture_source_key_unique" UNIQUE("source_key");