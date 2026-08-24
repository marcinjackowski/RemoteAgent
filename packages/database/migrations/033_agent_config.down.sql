-- RA-032 migration 033 (down): drop server-owned agent configuration.
DROP TABLE IF EXISTS agent_config;
