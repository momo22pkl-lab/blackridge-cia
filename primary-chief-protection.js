'use strict';

const PRIMARY_CHIEF_REPAIR_SQL = `
-- Restore only the unique existing CIA CHIEF row; leave all other JSON fields and audit history untouched.
WITH protected_chief AS (
  SELECT (chief.ordinality - 1)::text AS user_index
  FROM blackridge_app_state AS app_state
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(app_state.data->'cia_users', '[]'::jsonb)) WITH ORDINALITY AS chief(user_data, ordinality)
  WHERE app_state.id = 1
    AND upper(btrim(COALESCE(chief.user_data->>'rank', ''))) = 'CIA CHIEF'
    AND (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(app_state.data->'cia_users', '[]'::jsonb)) AS candidate(value)
      WHERE upper(btrim(COALESCE(candidate.value->>'rank', ''))) = 'CIA CHIEF'
    ) = 1
    AND (
      COALESCE(chief.user_data->>'suspended', 'false') <> 'false'
      OR COALESCE(chief.user_data->>'securityStatus', '') <> 'ACTIVE'
      OR COALESCE(chief.user_data->>'approved', 'false') <> 'true'
    )
)
UPDATE blackridge_app_state AS app_state
SET data = jsonb_set(
  jsonb_set(
    jsonb_set(
      app_state.data,
      ARRAY['cia_users', protected_chief.user_index, 'suspended'],
      'false'::jsonb,
      true
    ),
    ARRAY['cia_users', protected_chief.user_index, 'securityStatus'],
    '"ACTIVE"'::jsonb,
    true
  ),
  ARRAY['cia_users', protected_chief.user_index, 'approved'],
  'true'::jsonb,
  true
),
updated_at = NOW()
FROM protected_chief
WHERE app_state.id = 1;
`;

const PRIMARY_CHIEF_GUARD_SQL = `
CREATE OR REPLACE FUNCTION blackridge_protect_primary_chief_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_chief JSONB;
  new_chief JSONB;
  old_successor JSONB;
  replacement_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(OLD.data->'cia_users', '[]'::jsonb)) AS person(value)
      WHERE upper(btrim(COALESCE(person.value->>'rank', ''))) = 'CIA CHIEF'
    ) THEN
      RAISE EXCEPTION 'The Primary Chief state cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  FOR old_chief IN
    SELECT person.value
    FROM jsonb_array_elements(COALESCE(OLD.data->'cia_users', '[]'::jsonb)) AS person(value)
    WHERE upper(btrim(COALESCE(person.value->>'rank', ''))) = 'CIA CHIEF'
  LOOP
    new_chief := NULL;
    SELECT person.value INTO new_chief
    FROM jsonb_array_elements(COALESCE(NEW.data->'cia_users', '[]'::jsonb)) AS person(value)
    WHERE person.value->>'id' = old_chief->>'id'
    LIMIT 1;

    IF new_chief IS NULL THEN
      RAISE EXCEPTION 'The Primary Chief account cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    IF (old_chief->>'publicCode') IS DISTINCT FROM (new_chief->>'publicCode')
       OR (old_chief->>'secretCode') IS DISTINCT FROM (new_chief->>'secretCode')
       OR (old_chief->>'serviceApproved') IS DISTINCT FROM (new_chief->>'serviceApproved') THEN
      RAISE EXCEPTION 'The Primary Chief identity and access fields are protected.' USING ERRCODE = '42501';
    END IF;

    IF upper(btrim(COALESCE(new_chief->>'rank', ''))) = 'CIA CHIEF' THEN
      SELECT COUNT(*) INTO replacement_count
      FROM jsonb_array_elements(COALESCE(NEW.data->'cia_users', '[]'::jsonb)) AS person(value)
      WHERE upper(btrim(COALESCE(person.value->>'rank', ''))) = 'CIA CHIEF';
      IF replacement_count <> 1
         OR COALESCE(new_chief->>'suspended', 'false') <> 'false'
         OR COALESCE(new_chief->>'securityStatus', '') <> 'ACTIVE'
         OR COALESCE(new_chief->>'approved', 'false') <> 'true' THEN
        RAISE EXCEPTION 'The Primary Chief cannot be suspended, restricted, or disabled.' USING ERRCODE = '42501';
      END IF;
    ELSE
      SELECT COUNT(*) INTO replacement_count
      FROM jsonb_array_elements(COALESCE(NEW.data->'cia_users', '[]'::jsonb)) AS person(value)
      WHERE upper(btrim(COALESCE(person.value->>'rank', ''))) = 'CIA CHIEF';

      IF upper(btrim(COALESCE(new_chief->>'rank', ''))) <> 'SUPREME COMMANDER'
         OR replacement_count <> 1
         OR current_setting('blackridge.primary_chief_handover_actor_id', true) IS DISTINCT FROM (old_chief->>'id')
         OR COALESCE(new_chief->>'suspended', 'false') <> 'false'
         OR COALESCE(new_chief->>'securityStatus', '') <> 'ACTIVE'
         OR COALESCE(new_chief->>'approved', 'false') <> 'true' THEN
        RAISE EXCEPTION 'Only a verified Primary Chief handover may transfer the protected role.' USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(NEW.data->'cia_users', '[]'::jsonb)) AS replacement(value)
        WHERE upper(btrim(COALESCE(replacement.value->>'rank', ''))) = 'CIA CHIEF'
          AND (
            COALESCE(replacement.value->>'suspended', 'false') <> 'false'
            OR COALESCE(replacement.value->>'securityStatus', '') <> 'ACTIVE'
            OR COALESCE(replacement.value->>'approved', 'false') <> 'true'
            OR COALESCE(replacement.value->>'serviceApproved', 'false') <> 'true'
          )
      ) THEN
        RAISE EXCEPTION 'The incoming Primary Chief must remain enabled and approved.' USING ERRCODE = '42501';
      END IF;

      SELECT person.value INTO old_successor
      FROM jsonb_array_elements(COALESCE(OLD.data->'cia_users', '[]'::jsonb)) AS person(value)
      WHERE person.value->>'id' = (
        SELECT candidate.value->>'id'
        FROM jsonb_array_elements(COALESCE(NEW.data->'cia_users', '[]'::jsonb)) AS candidate(value)
        WHERE upper(btrim(COALESCE(candidate.value->>'rank', ''))) = 'CIA CHIEF'
        LIMIT 1
      )
      LIMIT 1;
      IF old_successor IS NULL OR upper(btrim(COALESCE(old_successor->>'rank', ''))) = 'CIA CHIEF' THEN
        RAISE EXCEPTION 'A handover must use an existing non-chief account.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blackridge_primary_chief_guard ON blackridge_app_state;
CREATE TRIGGER blackridge_primary_chief_guard
BEFORE UPDATE OR DELETE ON blackridge_app_state
FOR EACH ROW EXECUTE FUNCTION blackridge_protect_primary_chief_state();

CREATE OR REPLACE FUNCTION blackridge_prevent_primary_chief_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM blackridge_app_state AS app_state
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(app_state.data->'cia_users', '[]'::jsonb)) AS person(value)
    WHERE upper(btrim(COALESCE(person.value->>'rank', ''))) = 'CIA CHIEF'
  ) THEN
    RAISE EXCEPTION 'The Primary Chief state cannot be truncated.' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS blackridge_primary_chief_truncate_guard ON blackridge_app_state;
CREATE TRIGGER blackridge_primary_chief_truncate_guard
BEFORE TRUNCATE ON blackridge_app_state
FOR EACH STATEMENT EXECUTE FUNCTION blackridge_prevent_primary_chief_truncate();
`;

const PRIMARY_CHIEF_MIGRATION_SQL = 'DROP TRIGGER IF EXISTS blackridge_primary_chief_guard ON blackridge_app_state;\n' + PRIMARY_CHIEF_REPAIR_SQL + '\n' + PRIMARY_CHIEF_GUARD_SQL;

function isPrimaryChief(user) {
  return !!user && String(user.rank || '').trim().toUpperCase() === 'CIA CHIEF';
}

function restorePrimaryChiefAccess(user) {
  if (!isPrimaryChief(user)) return false;
  const changed = user.approved !== true || user.suspended !== false || user.securityStatus !== 'ACTIVE';
  user.approved = true;
  user.suspended = false;
  user.securityStatus = 'ACTIVE';
  return changed;
}

function restorePrimaryChiefInState(state) {
  const users = Array.isArray(state?.cia_users) ? state.cia_users : [];
  const chiefs = users.filter(isPrimaryChief);
  if (chiefs.length !== 1) return { restored: false, ambiguous: chiefs.length > 1 };
  return { restored: restorePrimaryChiefAccess(chiefs[0]), ambiguous: false, chiefId: chiefs[0].id || null };
}

module.exports = {
  PRIMARY_CHIEF_REPAIR_SQL,
  PRIMARY_CHIEF_GUARD_SQL,
  PRIMARY_CHIEF_MIGRATION_SQL,
  isPrimaryChief,
  restorePrimaryChiefAccess,
  restorePrimaryChiefInState
};
