-- Hand-written in place of the generated drop-and-recreate.
--
-- drizzle-kit emits a DROP TYPE / CREATE TYPE pair for an enum change, which
-- casts every existing value through text on the way back and fails outright on
-- any row still holding the old one. This is the same change stated as what it
-- actually is: the value is being renamed, not replaced.
ALTER TYPE "public"."user_role" RENAME VALUE 'moderator' TO 'game_master';
