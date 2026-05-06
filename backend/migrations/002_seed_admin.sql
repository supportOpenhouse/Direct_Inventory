-- Seed initial admin so the very first Google login works.
-- Replace email if onboarding a different first admin.

INSERT INTO users (email, name, role, cities, is_active)
VALUES ('ashish@openhouse.in', 'Ashish', 'admin',
        ARRAY['Noida','Gurgaon','Ghaziabad','Greater Noida'], TRUE)
ON CONFLICT (email) DO UPDATE SET role = 'admin', is_active = TRUE;
