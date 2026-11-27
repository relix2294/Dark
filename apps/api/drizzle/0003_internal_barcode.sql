-- Внутренние штрихкоды для товаров без штрихкода производителя (ТЗ §7): EAN-13 с префиксом 200 (внутримагазинный диапазон).
CREATE SEQUENCE IF NOT EXISTS internal_barcode_seq START 1;
