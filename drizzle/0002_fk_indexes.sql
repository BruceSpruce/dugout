CREATE INDEX "fixture_season_round_idx" ON "dugout_fixture" USING btree ("competition_season_id","round");--> statement-breakpoint
CREATE INDEX "fixture_home_club_idx" ON "dugout_fixture" USING btree ("home_club_id");--> statement-breakpoint
CREATE INDEX "fixture_away_club_idx" ON "dugout_fixture" USING btree ("away_club_id");--> statement-breakpoint
CREATE INDEX "squad_member_club_season_idx" ON "dugout_squad_member" USING btree ("club_id","competition_season_id");