ALTER TABLE "scrim_requests" ADD COLUMN "host_lineup" uuid[];--> statement-breakpoint
ALTER TABLE "scrim_requests" ADD COLUMN "guest_lineup" uuid[];--> statement-breakpoint
ALTER TABLE "scrim_requests" ADD COLUMN "confirm_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "is_starter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing rosters get the same default a new one would: the first five by
-- seniority start, the rest are substitutes. Without this every team already
-- registered would read as having nobody marked to play.
UPDATE "team_members" SET "is_starter" = true
WHERE "user_id" IN (
  SELECT "user_id" FROM (
    SELECT "user_id",
           ROW_NUMBER() OVER (PARTITION BY "team_id" ORDER BY "joined_at", "user_id") AS rn
    FROM "team_members"
  ) ranked
  WHERE rn <= 5
);
