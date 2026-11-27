CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"push_delivered_at" timestamp with time zone,
	"sms_due_at" timestamp with time zone,
	"sms_sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_uq" ON "notification" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_customer_idx" ON "notification" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_status_idx" ON "notification" USING btree ("status");