-- Инварианты, которые проверяет БД (ТЗ §2), и служебные объекты. Пишется руками, drizzle-kit их не генерирует.

-- Номера заказов: L-000001 / S-000001
CREATE SEQUENCE IF NOT EXISTS order_number_lab START 1;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS order_number_sor START 1;--> statement-breakpoint

-- stock_lot.qty >= reserved_qty >= 0
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_qty_reserved_chk" CHECK ("qty" >= "reserved_qty" AND "reserved_qty" >= 0);--> statement-breakpoint

-- payment.captured <= hold; refunded <= captured
ALTER TABLE "payment" ADD CONSTRAINT "payment_amounts_chk"
  CHECK ("captured_dirams" <= "hold_dirams" AND "refunded_dirams" <= "captured_dirams" AND "hold_dirams" >= 0);--> statement-breakpoint

-- order.total = items_total + delivery_fee − discount; все суммы >= 0
ALTER TABLE "order" ADD CONSTRAINT "order_total_chk"
  CHECK ("total_dirams" = "items_total_dirams" + "delivery_fee_dirams" - "discount_dirams"
    AND "items_total_dirams" >= 0 AND "delivery_fee_dirams" >= 0 AND "discount_dirams" >= 0);--> statement-breakpoint

-- Движение остатка без количества бессмысленно
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_qty_chk" CHECK ("qty" <> 0);--> statement-breakpoint

-- Товар с is_high_value лежит только в ячейке с камерой
CREATE OR REPLACE FUNCTION check_high_value_cell() RETURNS trigger AS $$
DECLARE
  hv boolean;
  cam boolean;
BEGIN
  IF NEW.cell_id IS NULL THEN RETURN NEW; END IF;
  SELECT is_high_value INTO hv FROM product WHERE id = NEW.product_id;
  IF NOT hv THEN RETURN NEW; END IF;
  SELECT is_camera_covered INTO cam FROM cell WHERE id = NEW.cell_id;
  IF NOT cam THEN
    RAISE EXCEPTION 'WRONG_CELL: дорогой товар % только в ячейку с камерой', NEW.product_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER stock_lot_high_value_cell BEFORE INSERT OR UPDATE OF cell_id, product_id ON "stock_lot"
  FOR EACH ROW EXECUTE FUNCTION check_high_value_cell();--> statement-breakpoint

-- Журнал действий неизменяем: запрещаем UPDATE и DELETE
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'таблица % только для добавления', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
CREATE TRIGGER order_status_log_immutable BEFORE UPDATE OR DELETE ON "order_status_log" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
CREATE TRIGGER stock_move_immutable BEFORE UPDATE OR DELETE ON "stock_move" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint

-- updated_at обновляется автоматически на всех таблицах с таким столбцом
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at'
             AND table_name NOT IN ('audit_log', 'order_status_log', 'stock_move')
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
  END LOOP;
END $$;
