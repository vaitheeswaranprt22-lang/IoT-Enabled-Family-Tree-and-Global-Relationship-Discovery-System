/**
 * Family timeline: births, marriages, deaths and other recorded events,
 * arranged chronologically.
 *
 * Birth and death events are derived from the person records themselves rather
 * than duplicated, so the timeline can never drift out of step with the tree.
 */
import { Router } from '../lib/http.js';
import { validate, parsePagination } from '../lib/validate.js';
import { all, get, run, newPublicId } from '../db/index.js';
import { viewPerson, canViewPerson, loadEditablePerson, readableOwnerIds } from '../lib/privacy.js';
import { recordChange } from '../lib/audit.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { yearOf } from '../lib/text.js';

const router = new Router();

const EVENT_TYPES = ['birth', 'death', 'marriage', 'divorce', 'adoption', 'graduation',
  'migration', 'military', 'residence', 'occupation', 'other'];

const TYPE_ICONS = {
  birth: 'birth', death: 'death', marriage: 'marriage', divorce: 'divorce',
  adoption: 'adoption', graduation: 'graduation', migration: 'migration',
  military: 'military', residence: 'residence', occupation: 'occupation', other: 'event',
};

// --------------------------------------------------------------- timeline ---

router.get('/', async (ctx) => {
  const ownerIds = ctx.query.scope === 'shared' ? readableOwnerIds(ctx.user) : [ctx.user.id];
  const placeholders = ownerIds.map(() => '?').join(',');
  const fromYear = ctx.query.from ? Number(ctx.query.from) : null;
  const toYear = ctx.query.to ? Number(ctx.query.to) : null;
  const typeFilter = ctx.query.type && EVENT_TYPES.includes(ctx.query.type) ? ctx.query.type : null;

  const entries = [];

  // 1. Explicit events.
  const eventRows = all(
    `SELECT e.*, p.display_name, p.public_id AS person_public_id, p.created_by_user_id, p.visibility AS person_visibility,
            p.is_living, p.gender
     FROM events e
     JOIN persons p ON p.id = e.person_id
     WHERE p.created_by_user_id IN (${placeholders}) AND p.merged_into_id IS NULL`,
    ...ownerIds
  );

  for (const row of eventRows) {
    const person = get(`SELECT * FROM persons WHERE id = ?`, row.person_id);
    if (!person || !canViewPerson(ctx.user, person)) continue;
    const view = viewPerson(ctx.user, person);
    // An event about a living person follows the same hiding rule as the person.
    if (view.detailsHidden && row.type !== 'birth') continue;
    if (typeFilter && row.type !== typeFilter) continue;

    entries.push({
      id: row.public_id,
      source: 'event',
      type: row.type,
      icon: TYPE_ICONS[row.type] ?? 'event',
      title: row.title,
      description: row.description,
      date: row.event_date,
      year: row.event_year ?? yearOf(row.event_date),
      precision: row.date_precision,
      place: row.place,
      person: view,
      relatedPerson: row.related_person_id
        ? (() => {
            const other = get(`SELECT * FROM persons WHERE id = ?`, row.related_person_id);
            return other && canViewPerson(ctx.user, other) ? viewPerson(ctx.user, other) : null;
          })()
        : null,
      editable: person.created_by_user_id === ctx.user.id,
      isSynthetic: row.is_synthetic === 1,
    });
  }

  // 2. Births and deaths derived from the person records.
  if (!typeFilter || typeFilter === 'birth' || typeFilter === 'death') {
    const people = all(
      `SELECT * FROM persons
       WHERE created_by_user_id IN (${placeholders}) AND merged_into_id IS NULL
         AND (birth_date IS NOT NULL OR birth_year IS NOT NULL OR death_date IS NOT NULL)`,
      ...ownerIds
    );

    for (const person of people) {
      if (!canViewPerson(ctx.user, person)) continue;
      const view = viewPerson(ctx.user, person);

      if ((!typeFilter || typeFilter === 'birth') && (view.birthDate || view.birthYear)) {
        entries.push({
          id: `birth:${person.public_id}`,
          source: 'derived',
          type: 'birth',
          icon: 'birth',
          title: `${view.displayName} was born`,
          date: view.birthDate,
          year: view.birthYear ?? yearOf(view.birthDate),
          precision: view.birthPrecision,
          place: view.birthPlace,
          person: view,
          editable: false,
          isSynthetic: person.is_synthetic === 1,
        });
      }

      if ((!typeFilter || typeFilter === 'death') && view.deathDate) {
        entries.push({
          id: `death:${person.public_id}`,
          source: 'derived',
          type: 'death',
          icon: 'death',
          title: `${view.displayName} died`,
          date: view.deathDate,
          year: yearOf(view.deathDate),
          precision: view.deathPrecision,
          place: view.deathPlace,
          person: view,
          editable: false,
          isSynthetic: person.is_synthetic === 1,
        });
      }
    }
  }

  // 3. Marriages derived from spouse edges with a start date.
  if (!typeFilter || typeFilter === 'marriage') {
    const marriages = all(
      `SELECT r.*, pa.display_name AS a_name, pb.display_name AS b_name
       FROM relationships r
       JOIN persons pa ON pa.id = r.from_person_id
       JOIN persons pb ON pb.id = r.to_person_id
       WHERE r.type = 'spouse' AND r.start_date IS NOT NULL
         AND (pa.created_by_user_id IN (${placeholders}) OR pb.created_by_user_id IN (${placeholders}))`,
      ...ownerIds, ...ownerIds
    );

    for (const row of marriages) {
      const a = get(`SELECT * FROM persons WHERE id = ?`, row.from_person_id);
      const b = get(`SELECT * FROM persons WHERE id = ?`, row.to_person_id);
      if (!a || !b || !canViewPerson(ctx.user, a) || !canViewPerson(ctx.user, b)) continue;
      entries.push({
        id: `marriage:${row.public_id}`,
        source: 'derived',
        type: 'marriage',
        icon: 'marriage',
        title: `${a.display_name} married ${b.display_name}`,
        date: row.start_date,
        year: yearOf(row.start_date),
        precision: 'exact',
        person: viewPerson(ctx.user, a),
        relatedPerson: viewPerson(ctx.user, b),
        verificationStatus: row.status,
        editable: false,
      });
    }
  }

  // Filter by year range, then sort oldest first with undated items at the end.
  const filtered = entries.filter((e) => {
    if (fromYear !== null && (e.year === null || e.year < fromYear)) return false;
    if (toYear !== null && (e.year === null || e.year > toYear)) return false;
    return true;
  });

  filtered.sort((x, y) => {
    if (x.year === null && y.year === null) return 0;
    if (x.year === null) return 1;
    if (y.year === null) return -1;
    if (x.year !== y.year) return x.year - y.year;
    return String(x.date ?? '').localeCompare(String(y.date ?? ''));
  });

  const years = filtered.map((e) => e.year).filter((y) => y !== null);

  // Group by decade for the timeline's navigation rail.
  const decades = new Map();
  for (const entry of filtered) {
    if (entry.year === null) continue;
    const decade = Math.floor(entry.year / 10) * 10;
    decades.set(decade, (decades.get(decade) ?? 0) + 1);
  }

  return {
    events: filtered,
    total: filtered.length,
    range: years.length ? { earliest: Math.min(...years), latest: Math.max(...years) } : null,
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]).map(([decade, count]) => ({ decade, count })),
    types: EVENT_TYPES,
  };
});

// ----------------------------------------------------------------- events ---

router.post('/events', async (ctx) => {
  const input = validate(ctx.body, {
    personId: { type: 'string', required: true, maxLength: 64, label: 'Person' },
    relatedPersonId: { type: 'string', maxLength: 64 },
    type: { type: 'enum', required: true, values: EVENT_TYPES, label: 'Event type' },
    title: { type: 'string', required: true, maxLength: 200, label: 'Title' },
    description: { type: 'string', maxLength: 2000 },
    date: { type: 'date' },
    precision: { type: 'enum', values: ['exact', 'month', 'year', 'about', 'unknown'], default: 'exact' },
    place: { type: 'string', maxLength: 200 },
    visibility: { type: 'enum', values: ['private', 'family', 'public'], default: 'family' },
  });

  const person = loadEditablePerson(ctx.user, input.personId);

  let relatedId = null;
  if (input.relatedPersonId) {
    const related = get(`SELECT * FROM persons WHERE public_id = ?`, input.relatedPersonId);
    if (!related) throw notFound('The related person was not found.');
    if (!canViewPerson(ctx.user, related)) throw notFound('The related person was not found.');
    relatedId = related.id;
  }

  const publicId = newPublicId();
  run(
    `INSERT INTO events
       (public_id, person_id, related_person_id, type, title, description,
        event_date, date_precision, event_year, place, visibility, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    publicId, person.id, relatedId, input.type, input.title, input.description ?? null,
    input.date ?? null, input.precision, yearOf(input.date), input.place ?? null,
    input.visibility, ctx.user.id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'event', entityId: null, entityLabel: input.title,
    action: 'Event Added', newValue: `${input.type}: ${input.title}`, ip: ctx.ip,
  });

  return { __status: 201, event: { id: publicId, ...input } };
});

router.patch('/events/:id', async (ctx) => {
  const event = get(`SELECT * FROM events WHERE public_id = ?`, ctx.params.id);
  if (!event) throw notFound('Event not found.');
  const person = get(`SELECT * FROM persons WHERE id = ?`, event.person_id);
  loadEditablePerson(ctx.user, person.public_id);

  const input = validate(ctx.body, {
    title: { type: 'string', maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    date: { type: 'date' },
    precision: { type: 'enum', values: ['exact', 'month', 'year', 'about', 'unknown'] },
    place: { type: 'string', maxLength: 200 },
    visibility: { type: 'enum', values: ['private', 'family', 'public'] },
  });

  const map = { title: 'title', description: 'description', date: 'event_date',
    precision: 'date_precision', place: 'place', visibility: 'visibility' };
  const columns = {};
  for (const [key, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) columns[column] = input[key];
  }
  if ('event_date' in columns) columns.event_year = yearOf(columns.event_date);
  if (!Object.keys(columns).length) throw badRequest('No changes were supplied.');

  const names = Object.keys(columns);
  run(
    `UPDATE events SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`,
    ...names.map((n) => columns[n]), event.id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'event', entityId: event.id, entityLabel: event.title,
    action: 'Event Updated', detail: names.join(', '), ip: ctx.ip,
  });

  return { event: get(`SELECT * FROM events WHERE id = ?`, event.id) };
});

router.delete('/events/:id', async (ctx) => {
  const event = get(`SELECT * FROM events WHERE public_id = ?`, ctx.params.id);
  if (!event) throw notFound('Event not found.');
  const person = get(`SELECT * FROM persons WHERE id = ?`, event.person_id);
  loadEditablePerson(ctx.user, person.public_id);

  run(`DELETE FROM events WHERE id = ?`, event.id);
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'event', entityId: event.id, entityLabel: event.title,
    action: 'Event Deleted', oldValue: event.title, ip: ctx.ip,
  });
  return { ok: true };
});

export default router;
