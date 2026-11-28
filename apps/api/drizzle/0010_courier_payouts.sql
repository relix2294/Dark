CREATE TYPE "public"."payout_kind" AS ENUM('shift', 'bonus');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'sent', 'failed', 'no_wallet');--> statement-breakpoint
CREATE TABLE "courier_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"courier_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"shift_id" uuid,
	"kind" "payout_kind" NOT NULL,
	"amount_dirams" integer NOT NULL,
	"breakdown" jsonb,
	"reason" text,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"provider_ref" text,
	"sent_at" timestamp with time zone,
	"created_by" text,
	CONSTRAINT "courier_payout_shift_id_unique" UNIQUE("shift_id"),
	CONSTRAINT "courier_payout_amount_chk" CHECK ("courier_payout"."amount_dirams" > 0)
);
--> statement-breakpoint
ALTER TABLE "user_staff" ADD COLUMN "dc_user_id" text;--> statement-breakpoint
ALTER TABLE "courier_payout" ADD CONSTRAINT "courier_payout_courier_id_courier_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."courier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_payout" ADD CONSTRAINT "courier_payout_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_payout" ADD CONSTRAINT "courier_payout_shift_id_courier_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."courier_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courier_payout_store_idx" ON "courier_payout" USING btree ("store_id","created_at");--> statement-breakpoint
ALTER TABLE "user_staff" ADD CONSTRAINT "user_staff_dc_user_id_unique" UNIQUE("dc_user_id");