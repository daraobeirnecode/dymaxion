-- Default user preferences (single row per key; JSONB values).

INSERT INTO dymaxion.preferences (key, value) VALUES
  ('coord_system_preference', '"EPSG:3857 for web, EPSG:26910 for California local"'),
  ('default_pdf_theme', '"minimal"'),
  ('default_python_style', '"PEP 8 with 100-char lines"'),
  ('default_map_style', '"clean, high-contrast, colorblind-safe"'),
  ('notification_gateway', '"telegram"'),
  ('approval_timeout_minutes', '30')
ON CONFLICT (key) DO NOTHING;
