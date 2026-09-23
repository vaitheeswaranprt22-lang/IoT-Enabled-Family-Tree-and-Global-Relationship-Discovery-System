/**
 * Privacy settings.
 *
 * These are not cosmetic. `backend/lib/privacy.js` reads them on every person
 * read, every search and every match scan, so turning something off here
 * removes the data from responses rather than hiding it in the interface.
 */
import { Router } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { all, get, run } from '../db/index.js';
import { recordChange } from '../lib/audit.js';
import { privacyFor, clearAccessCache } from '../lib/privacy.js';
import { badRequest } from '../lib/errors.js';

const router = new Router();

const VISIBILITY = ['private', 'family', 'public'];

const EXPLANATIONS = {
  defaultPersonVisibility: 'Visibility given to each new person you add. You can still change it per person.',
  profileVisibility: 'Who can see your account profile.',
  hideLivingDetails: 'Hides exact dates, places and notes for people who are still alive from anyone who cannot edit your tree.',
  allowMatchDiscovery: 'Lets other users’ possible-match scans consider people in your tree. Turning this off removes them from other people’s candidate lists entirely.',
  allowRelationshipSearch: 'Lets other users run "How am I related?" towards people in your tree.',
  allowAiSuggestions: 'Allows the AI-assisted layer to analyse your records when producing suggestions.',
  showInDirectory: 'Lists your tree in the public directory of registered family trees.',
};

function serialize(row) {
  return {
    defaultPersonVisibility: row.default_person_visibility,
    profileVisibility: row.profile_visibility,
    hideLivingDetails: row.hide_living_details === 1,
    allowMatchDiscovery: row.allow_match_discovery === 1,
    allowRelationshipSearch: row.allow_relationship_search === 1,
    allowAiSuggestions: row.allow_ai_suggestions === 1,
    showInDirectory: row.show_in_directory === 1,
    updatedAt: row.updated_at,
  };
}

router.get('/', async (ctx) => {
  const settings = privacyFor(ctx.user.id);

  // How the current settings actually play out across the user's records.
  const breakdown = all(
    `SELECT visibility, COUNT(*) AS n FROM persons
     WHERE created_by_user_id = ? AND merged_into_id IS NULL
     GROUP BY visibility`,
    ctx.user.id
  );
  const living = get(
    `SELECT COUNT(*) AS n FROM persons WHERE created_by_user_id = ? AND is_living = 1 AND merged_into_id IS NULL`,
    ctx.user.id
  )?.n ?? 0;

  return {
    settings: serialize(settings),
    explanations: EXPLANATIONS,
    visibilityOptions: [
      { value: 'private', label: 'Private', description: 'Only you can see this person.' },
      { value: 'family', label: 'Family Only', description: 'You and the collaborators you have approved.' },
      { value: 'public', label: 'Public', description: 'Any signed-in user of this platform.' },
    ],
    impact: {
      personsByVisibility: Object.fromEntries(breakdown.map((r) => [r.visibility, r.n])),
      livingPeopleProtected: settings.hide_living_details === 1 ? living : 0,
      totalLiving: living,
    },
  };
});

router.put('/', async (ctx) => {
  const input = validate(ctx.body, {
    defaultPersonVisibility: { type: 'enum', values: VISIBILITY },
    profileVisibility: { type: 'enum', values: VISIBILITY },
    hideLivingDetails: { type: 'bool' },
    allowMatchDiscovery: { type: 'bool' },
    allowRelationshipSearch: { type: 'bool' },
    allowAiSuggestions: { type: 'bool' },
    showInDirectory: { type: 'bool' },
  });

  const map = {
    defaultPersonVisibility: 'default_person_visibility',
    profileVisibility: 'profile_visibility',
    hideLivingDetails: 'hide_living_details',
    allowMatchDiscovery: 'allow_match_discovery',
    allowRelationshipSearch: 'allow_relationship_search',
    allowAiSuggestions: 'allow_ai_suggestions',
    showInDirectory: 'show_in_directory',
  };

  const before = privacyFor(ctx.user.id);
  const columns = {};
  for (const [key, column] of Object.entries(map)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    columns[column] = typeof input[key] === 'boolean' ? (input[key] ? 1 : 0) : input[key];
  }
  if (!Object.keys(columns).length) throw badRequest('No settings were supplied.');

  // Ensure a row exists before updating (older accounts, imported data).
  run(`INSERT OR IGNORE INTO privacy_settings (user_id) VALUES (?)`, ctx.user.id);

  const names = Object.keys(columns);
  run(
    `UPDATE privacy_settings SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = datetime('now')
     WHERE user_id = ?`,
    ...names.map((n) => columns[n]), ctx.user.id
  );

  for (const column of names) {
    if (String(before[column] ?? '') === String(columns[column])) continue;
    recordChange({
      actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
      entityType: 'privacy', entityId: ctx.user.id, entityLabel: 'Privacy settings',
      action: 'Privacy Setting Changed', field: column,
      oldValue: before[column], newValue: columns[column], ip: ctx.ip,
    });
  }

  clearAccessCache();

  return { settings: serialize(privacyFor(ctx.user.id)), ok: true };
});

/** Bulk-applies a visibility level to every person in the user's tree. */
router.post('/apply-to-all', async (ctx) => {
  const input = validate(ctx.body, {
    visibility: { type: 'enum', values: VISIBILITY, required: true, label: 'Visibility' },
    onlyLiving: { type: 'bool', default: false },
  });

  const filter = input.onlyLiving ? 'AND is_living = 1' : '';
  const result = run(
    `UPDATE persons SET visibility = ?, updated_at = datetime('now')
     WHERE created_by_user_id = ? AND merged_into_id IS NULL ${filter}`,
    input.visibility, ctx.user.id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'privacy', entityId: ctx.user.id, entityLabel: 'Bulk visibility change',
    action: 'Privacy Setting Changed', field: 'visibility',
    newValue: input.visibility,
    detail: `Applied to ${result.changes} person record(s)${input.onlyLiving ? ' (living only)' : ''}.`,
    ip: ctx.ip,
  });

  return { ok: true, updated: result.changes, visibility: input.visibility };
});

export default router;
