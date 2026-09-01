-- Jurisdiction rules as data.
--
-- Only a handful of things actually vary between state student privacy
-- statutes: the breach clock, the named security framework, the rights a
-- parent can exercise, and whether the agreement must be published. That is a
-- schema, which means the answer is configuration rather than fifty code paths.
--
-- The clocks below are the ones that change engineering. New York gives seven
-- calendar days from discovery; Illinois gives thirty from determination. A
-- single global runbook satisfies neither.

INSERT INTO jurisdictions (code, name, breach_notify_hours, breach_trigger, breach_unit, security_framework, parent_rights_json, publication_required, statute, notes) VALUES
('NY', 'New York', 168, 'discovery', 'calendar', 'NIST CSF',
 '["inspect","correct"]', 1, 'Education Law 2-d / 8 NYCRR Part 121',
 'Requires a Parents Bill of Rights and a data security and privacy plan aligned to the NIST Cybersecurity Framework.'),
('IL', 'Illinois', 720, 'determination', 'calendar', NULL,
 '["inspect","correct","delete"]', 1, 'SOPPA, 105 ILCS 85',
 'Written agreement per operator. Schools must publish their agreements.'),
('CA', 'California', 0, 'not specified', 'calendar', NULL,
 '["inspect","correct","delete"]', 0, 'SOPIPA Ed Code 22584 / AB 1584',
 'No targeted advertising, no non-educational profiling, no sale of student data.'),
('TX', 'Texas', 0, 'not specified', 'calendar', 'TX-RAMP',
 '["inspect","correct"]', 0, 'Education Code 32.151 et seq.',
 'TX-RAMP applies to cloud services sold to state agencies.'),
('CO', 'Colorado', 720, 'determination', 'calendar', NULL,
 '["inspect","correct"]', 1, 'Student Data Transparency and Security Act',
 'Providers appear on a published list.'),
('CT', 'Connecticut', 48, 'discovery', 'calendar', NULL,
 '["inspect","correct"]', 1, 'Conn. Gen. Stat. 10-234aa et seq.',
 'Contracts must be posted. A short clock, frequently overlooked.');
