CREATE TYPE "public"."call_role" AS ENUM('courier', 'customer');--> statement-breakpoint
CREATE TABLE "call_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_role" "call_role" NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"courier_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"number_for_courier" text NOT NULL,
	"number_for_customer" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "call_attempt" ADD CONSTRAINT "call_attempt_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_session" ADD CONSTRAINT "call_session_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_session" ADD CONSTRAINT "call_session_courier_id_courier_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."courier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_attempt_order_idx" ON "call_attempt" USING btree ("order_id","from_role");--> statement-breakpoint
CREATE UNIQUE INDEX "call_session_active_order_uq" ON "call_session" USING btree ("order_id") WHERE closed_at is null;