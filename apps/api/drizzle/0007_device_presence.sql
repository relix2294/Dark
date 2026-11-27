CREATE TYPE "public"."device_app" AS ENUM('picker', 'kds');--> statement-breakpoint
CREATE TABLE "device_presence" (
	"device_id" text PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"app" "device_app" NOT NULL,
	"staff_id" uuid,
	"last_seen_at" timestamp with time zone NOT NULL,
	"signed_off_at" timestamp with time zone,
	"offline_alerted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_presence" ADD CONSTRAINT "device_presence_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_presence" ADD CONSTRAINT "device_presence_staff_id_user_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."user_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_presence_store_idx" ON "device_presence" USING btree ("store_id","last_seen_at");