CREATE TYPE "public"."rating_tag" AS ENUM('late', 'missing_items', 'wrong_items', 'damaged', 'quality', 'courier');--> statement-breakpoint
CREATE TABLE "order_rating" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"tags" "rating_tag"[] DEFAULT '{}' NOT NULL,
	"comment" text,
	CONSTRAINT "order_rating_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "order_rating_score_chk" CHECK ("order_rating"."score" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "order_rating" ADD CONSTRAINT "order_rating_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_rating" ADD CONSTRAINT "order_rating_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_rating" ADD CONSTRAINT "order_rating_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_rating_store_idx" ON "order_rating" USING btree ("store_id","created_at");