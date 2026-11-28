-- updated_at на таблицах, появившихся после 0001_invariants (тот цикл создал триггер только для таблиц того момента).
-- Идемпотентно: триггер создаётся там, где его ещё нет. Новые таблицы — тест test/schema.test.ts напомнит.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
             AND c.table_name NOT IN ('audit_log', 'order_status_log', 'stock_move')
             AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = c.table_name || '_updated_at')
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
  END LOOP;
END $$;
