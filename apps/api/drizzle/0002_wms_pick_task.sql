CREATE TABLE "pick_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"picker_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"label_barcode" text,
	CONSTRAINT "pick_task_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "order_item" ADD COLUMN "missing_meta" jsonb;--> statement-breakpoint
ALTER TABLE "pick_task" ADD CONSTRAINT "pick_task_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pick_task_picker_status_idx" ON "pick_task" USING btree ("picker_id","status");