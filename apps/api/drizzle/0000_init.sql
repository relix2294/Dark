CREATE TYPE "public"."actor_type" AS ENUM('customer', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."brand" AS ENUM('LAB', 'SOR');--> statement-breakpoint
CREATE TYPE "public"."courier_status" AS ENUM('offline', 'free', 'assigned', 'delivering', 'returning', 'break');--> statement-breakpoint
CREATE TYPE "public"."delivery_task_status" AS ENUM('offered', 'expired', 'accepted', 'reassigned', 'at_store', 'picked_up', 'delivering', 'failed', 'done');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('pending', 'picked', 'replaced', 'missing');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('created', 'paid_hold', 'payment_failed', 'picking', 'cooking', 'ready', 'on_the_way', 'delivered', 'returning', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_op_type" AS ENUM('hold', 'capture', 'release', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('new', 'hold_pending', 'held', 'failed', 'released', 'capture_pending', 'captured', 'refund_pending', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."promo_audience" AS ENUM('new', 'all', 'segment');--> statement-breakpoint
CREATE TYPE "public"."promo_type" AS ENUM('free_delivery', 'percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."replace_policy" AS ENUM('call', 'auto', 'remove');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('picker', 'cook', 'courier', 'shift_lead', 'manager', 'finance', 'admin');--> statement-breakpoint
CREATE TYPE "public"."station" AS ENUM('pizza', 'grill', 'cold', 'pack');--> statement-breakpoint
CREATE TYPE "public"."stock_move_type" AS ENUM('receive', 'place', 'reserve', 'pick', 'unreserve', 'write_off', 'return', 'adjust');--> statement-breakpoint
CREATE TYPE "public"."temp_zone" AS ENUM('ambient', 'chill', 'frozen');--> statement-breakpoint
CREATE TYPE "public"."transport" AS ENUM('foot', 'bike', 'moto');--> statement-breakpoint
CREATE TABLE "address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"street" text NOT NULL,
	"house" text NOT NULL,
	"entrance" text,
	"floor" text,
	"flat" text,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brand" "brand" NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"parent_id" uuid
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dc_user_id" text NOT NULL,
	"phone_masked" text,
	"name" text,
	"first_order_at" timestamp with time zone,
	"orders_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "customer_dc_user_id_unique" UNIQUE("dc_user_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_zone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"brand" "brand" NOT NULL,
	"polygon" jsonb NOT NULL,
	"fee_dirams" integer NOT NULL,
	"min_order_dirams" integer NOT NULL,
	"eta_min" integer NOT NULL,
	"eta_max" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dish" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"station" "station" NOT NULL,
	"cook_time_sec" integer NOT NULL,
	"modifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipe" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "dish_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"price_dirams" integer NOT NULL,
	"old_price_dirams" integer,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brand" "brand" NOT NULL,
	"sku" text NOT NULL,
	"name_ru" text NOT NULL,
	"name_tj" text,
	"category_id" uuid,
	"barcodes" text[] DEFAULT '{}' NOT NULL,
	"unit" text DEFAULT 'шт' NOT NULL,
	"weight_g" integer,
	"is_weighted" boolean DEFAULT false NOT NULL,
	"temp_zone" "temp_zone" DEFAULT 'ambient' NOT NULL,
	"is_high_value" boolean DEFAULT false NOT NULL,
	"is_age_restricted" boolean DEFAULT false NOT NULL,
	"shelf_life_days" integer,
	"photo_url" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"address" text NOT NULL,
	"brands" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"work_hours" jsonb NOT NULL,
	CONSTRAINT "store_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phone" text NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"store_id" uuid,
	"pin_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "user_staff_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" text NOT NULL,
	"brand" "brand" NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_snapshot" jsonb NOT NULL,
	"status" "order_status" DEFAULT 'created' NOT NULL,
	"items_total_dirams" integer NOT NULL,
	"delivery_fee_dirams" integer NOT NULL,
	"discount_dirams" integer DEFAULT 0 NOT NULL,
	"total_dirams" integer NOT NULL,
	"captured_dirams" integer,
	"promised_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancel_reason" text,
	"comment" text DEFAULT '' NOT NULL,
	CONSTRAINT "order_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "order_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name_snapshot" text NOT NULL,
	"qty_ordered" integer NOT NULL,
	"qty_picked" integer DEFAULT 0 NOT NULL,
	"price_dirams" integer NOT NULL,
	"status" "order_item_status" DEFAULT 'pending' NOT NULL,
	"replace_policy" "replace_policy" DEFAULT 'call' NOT NULL,
	"replaced_by_item_id" uuid,
	"modifiers" jsonb
);
--> statement-breakpoint
CREATE TABLE "order_status_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"from" "order_status",
	"to" "order_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider_ref" text,
	"status" "payment_status" DEFAULT 'new' NOT NULL,
	"hold_dirams" integer NOT NULL,
	"captured_dirams" integer DEFAULT 0 NOT NULL,
	"refunded_dirams" integer DEFAULT 0 NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "payment_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "payment_op" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"type" "payment_op_type" NOT NULL,
	"amount_dirams" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_response" jsonb
);
--> statement-breakpoint
CREATE TABLE "promo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"brand" "brand",
	"type" "promo_type" NOT NULL,
	"value" integer NOT NULL,
	"audience" "promo_audience" DEFAULT 'all' NOT NULL,
	"per_customer_limit" integer DEFAULT 1 NOT NULL,
	"budget_dirams" integer,
	"spent_dirams" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	CONSTRAINT "promo_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "promo_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promo_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_dirams" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cell" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"code" text NOT NULL,
	"temp_zone" "temp_zone" DEFAULT 'ambient' NOT NULL,
	"is_camera_covered" boolean DEFAULT false NOT NULL,
	"pick_seq" integer NOT NULL,
	"capacity_units" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"cell_id" uuid,
	"qty" integer DEFAULT 0 NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"supply_id" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_move" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_id" uuid,
	"type" "stock_move_type" NOT NULL,
	"qty" integer NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"actor_id" text,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "stocktake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stocktake_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stocktake_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_system" integer NOT NULL,
	"qty_fact" integer,
	"counted_by" text,
	"recount_required" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier" text NOT NULL,
	"status" text DEFAULT 'expected' NOT NULL,
	"expected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supply_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supply_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_expected" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "courier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_id" uuid NOT NULL,
	"transport" "transport" DEFAULT 'bike' NOT NULL,
	"status" "courier_status" DEFAULT 'offline' NOT NULL,
	"current_store_id" uuid,
	CONSTRAINT "courier_staff_id_unique" UNIQUE("staff_id")
);
--> statement-breakpoint
CREATE TABLE "courier_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"date" text NOT NULL,
	"hour" integer NOT NULL,
	"forecast_orders_lab" integer DEFAULT 0 NOT NULL,
	"forecast_orders_sor" integer DEFAULT 0 NOT NULL,
	"couriers_needed" integer DEFAULT 0 NOT NULL,
	"couriers_planned" integer DEFAULT 0 NOT NULL,
	"edited_by" text
);
--> statement-breakpoint
CREATE TABLE "courier_position" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"courier_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"accuracy_m" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"courier_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"planned_from" timestamp with time zone,
	"planned_to" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delivery_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"courier_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "delivery_task_status" DEFAULT 'offered' NOT NULL,
	"order_ids" uuid[] NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"picked_up_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"assigned_by" text DEFAULT 'auto' NOT NULL,
	"override_reason" text,
	"dispatch_snapshot" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"store_id" uuid
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kds_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"station" "station" NOT NULL,
	"cook_time_sec" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"target_ready_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"topic" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "parameter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"edited_by" text
);
--> statement-breakpoint
CREATE TABLE "stop_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid,
	"ingredient_id" uuid,
	"set_by" text,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_zone" ADD CONSTRAINT "delivery_zone_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dish" ADD CONSTRAINT "dish_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price" ADD CONSTRAINT "price_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price" ADD CONSTRAINT "price_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_staff" ADD CONSTRAINT "user_staff_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_log" ADD CONSTRAINT "order_status_log_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_op" ADD CONSTRAINT "payment_op_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_use" ADD CONSTRAINT "promo_use_promo_id_promo_id_fk" FOREIGN KEY ("promo_id") REFERENCES "public"."promo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_use" ADD CONSTRAINT "promo_use_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_use" ADD CONSTRAINT "promo_use_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell" ADD CONSTRAINT "cell_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_cell_id_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cell"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_supply_id_supply_id_fk" FOREIGN KEY ("supply_id") REFERENCES "public"."supply"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_lot_id_stock_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktake" ADD CONSTRAINT "stocktake_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_stocktake_id_stocktake_id_fk" FOREIGN KEY ("stocktake_id") REFERENCES "public"."stocktake"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_cell_id_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cell"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply" ADD CONSTRAINT "supply_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_item" ADD CONSTRAINT "supply_item_supply_id_supply_id_fk" FOREIGN KEY ("supply_id") REFERENCES "public"."supply"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_item" ADD CONSTRAINT "supply_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier" ADD CONSTRAINT "courier_staff_id_user_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."user_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier" ADD CONSTRAINT "courier_current_store_id_store_id_fk" FOREIGN KEY ("current_store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_plan" ADD CONSTRAINT "courier_plan_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_position" ADD CONSTRAINT "courier_position_courier_id_courier_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."courier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_shift" ADD CONSTRAINT "courier_shift_courier_id_courier_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."courier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_shift" ADD CONSTRAINT "courier_shift_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_task" ADD CONSTRAINT "delivery_task_courier_id_courier_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."courier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_task" ADD CONSTRAINT "delivery_task_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kds_item" ADD CONSTRAINT "kds_item_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kds_item" ADD CONSTRAINT "kds_item_order_item_id_order_item_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kds_item" ADD CONSTRAINT "kds_item_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter" ADD CONSTRAINT "parameter_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stop_list" ADD CONSTRAINT "stop_list_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_zone_store_brand_idx" ON "delivery_zone" USING btree ("store_id","brand");--> statement-breakpoint
CREATE INDEX "price_lookup_idx" ON "price" USING btree ("product_id","store_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "product_brand_sku_uq" ON "product" USING btree ("brand","sku");--> statement-breakpoint
CREATE INDEX "product_barcodes_idx" ON "product" USING gin ("barcodes");--> statement-breakpoint
CREATE INDEX "order_store_status_idx" ON "order" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "order_customer_idx" ON "order" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "order_item_order_idx" ON "order_item" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_status_log_order_idx" ON "order_status_log" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_op_idem_uq" ON "payment_op" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "promo_use_promo_customer_idx" ON "promo_use" USING btree ("promo_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cell_store_code_uq" ON "cell" USING btree ("store_id","code");--> statement-breakpoint
CREATE INDEX "stock_lot_store_product_idx" ON "stock_lot" USING btree ("store_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_lot_cell_idx" ON "stock_lot" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "stock_move_lot_idx" ON "stock_move" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "stock_move_ref_idx" ON "stock_move" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "courier_position_courier_at_idx" ON "courier_position" USING btree ("courier_id","at");--> statement-breakpoint
CREATE INDEX "delivery_task_courier_status_idx" ON "delivery_task" USING btree ("courier_id","status");--> statement-breakpoint
CREATE INDEX "audit_log_object_idx" ON "audit_log" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_uq" ON "idempotency_key" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "kds_item_store_station_idx" ON "kds_item" USING btree ("store_id","station","start_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "parameter_store_key_uq" ON "parameter" USING btree ("store_id","key");--> statement-breakpoint
CREATE INDEX "stop_list_store_idx" ON "stop_list" USING btree ("store_id","cleared_at");