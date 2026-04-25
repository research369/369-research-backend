-- Migration 0007: Widen varchar fields for international addresses
-- house_number: 20 -> 100 (for complex address formats like "115, Loja 43, 4. Etage")
-- street: 200 -> 300 (for long international street names)
-- first_name/last_name: 100 -> 200 (for multi-part names)
-- zip: 20 -> 30 (for international postal codes)

ALTER TABLE orders ALTER COLUMN house_number TYPE varchar(100);
ALTER TABLE customers ALTER COLUMN house_number TYPE varchar(100);
ALTER TABLE partners ALTER COLUMN house_number TYPE varchar(100);

ALTER TABLE orders ALTER COLUMN street TYPE varchar(300);
ALTER TABLE customers ALTER COLUMN street TYPE varchar(300);
ALTER TABLE partners ALTER COLUMN street TYPE varchar(300);

ALTER TABLE orders ALTER COLUMN first_name TYPE varchar(200);
ALTER TABLE orders ALTER COLUMN last_name TYPE varchar(200);
ALTER TABLE customers ALTER COLUMN first_name TYPE varchar(200);
ALTER TABLE customers ALTER COLUMN last_name TYPE varchar(200);

ALTER TABLE orders ALTER COLUMN zip TYPE varchar(30);
ALTER TABLE customers ALTER COLUMN zip TYPE varchar(30);
ALTER TABLE partners ALTER COLUMN zip TYPE varchar(30);
