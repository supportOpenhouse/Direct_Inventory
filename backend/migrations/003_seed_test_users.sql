-- Seed test accounts for Saransh (manager) and Sahaj (RM).
-- Idempotent: re-running upgrades existing rows but does not clobber phone/cities if already set.

INSERT INTO users (email, name, phone, role, cities, is_active)
VALUES
    ('saransh.khera@openhouse.in', 'Saransh Khera', '8595594789', 'manager',
     ARRAY['Noida','Gurgaon','Ghaziabad','Greater Noida'], TRUE),
    ('sahaj.dureja@openhouse.in',  'Sahaj Dureja',  NULL,        'rm',
     ARRAY['Noida'], TRUE)
ON CONFLICT (email) DO UPDATE
    SET role = EXCLUDED.role,
        name = COALESCE(users.name, EXCLUDED.name),
        phone = COALESCE(users.phone, EXCLUDED.phone),
        cities = CASE WHEN COALESCE(array_length(users.cities, 1), 0) = 0
                      THEN EXCLUDED.cities ELSE users.cities END,
        is_active = TRUE;
