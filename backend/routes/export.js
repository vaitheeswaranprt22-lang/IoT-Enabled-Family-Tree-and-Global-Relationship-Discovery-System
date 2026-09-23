/**
 * Export and backup.
 *
 *   JSON    complete, machine-readable snapshot of what the caller may see
 *   GEDCOM  the genealogy interchange standard (5.5.1), readable by other apps
 *   SVG     a rendered tree, which the browser turns into PNG or PDF
 *   backup  a full restorable archive of the caller's own tree
 *
 * Privacy is applied to every export: a collaborator exporting a shared tree
 * gets exactly the fields they can see on screen, never the underlying row.
 */
import { Router } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { all, get, run, transaction, newPublicId } from '../db/index.js';
import { viewPerson, canViewPerson, readableOwnerIds, privacyFor } from '../lib/privacy.js';
import { loadGraph, expandAround } from '../engine/graph.js';
import { createPerson, createRelationship } from '../lib/person-service.js';
import { recordChange, logSecurity } from '../lib/audit.js';
import { escapeHtml } from '../lib/validate.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import config from '../config.js';

const router = new Router();

/** Collects everything the caller may see in one tree. */
function collectTree(ctx, ownerId) {
  const persons = all(
    `SELECT * FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL ORDER BY id`,
    ownerId
  ).filter((p) => canViewPerson(ctx.user, p));

  const idSet = new Set(persons.map((p) => p.id));

  const relationships = all(
    `SELECT r.* FROM relationships r
     WHERE r.from_person_id IN (SELECT id FROM persons WHERE created_by_user_id = ?)
        OR r.to_person_id IN (SELECT id FROM persons WHERE created_by_user_id = ?)`,
    ownerId, ownerId
  ).filter((r) => idSet.has(r.from_person_id) && idSet.has(r.to_person_id));

  const events = all(
    `SELECT e.* FROM events e
     JOIN persons p ON p.id = e.person_id
     WHERE p.created_by_user_id = ?`,
    ownerId
  ).filter((e) => idSet.has(e.person_id));

  return { persons, relationships, events, idSet };
}

// ------------------------------------------------------------------ JSON ---

router.get('/tree.json', async (ctx) => {
  const ownerId = ctx.query.owner
    ? get(`SELECT id FROM users WHERE public_id = ?`, ctx.query.owner)?.id
    : ctx.user.id;
  if (!ownerId) throw notFound('That tree was not found.');
  if (!readableOwnerIds(ctx.user).includes(ownerId)) throw forbidden('You cannot export that tree.');

  const { persons, relationships, events } = collectTree(ctx, ownerId);
  const owner = get(`SELECT public_id, display_name FROM users WHERE id = ?`, ownerId);
  const byId = new Map(persons.map((p) => [p.id, p.public_id]));

  const payload = {
    format: 'global-family-tree/v1',
    exportedAt: new Date().toISOString(),
    exportedBy: { id: ctx.user.publicId, name: ctx.user.displayName },
    tree: { ownerId: owner.public_id, ownerName: owner.display_name },
    privacyNote:
      'This export contains only the records the exporting account is permitted to see. Fields hidden by the owner’s privacy settings are omitted.',
    counts: { persons: persons.length, relationships: relationships.length, events: events.length },
    persons: persons.map((p) => viewPerson(ctx.user, p, { includeAudit: true })),
    relationships: relationships.map((r) => ({
      id: r.public_id,
      from: byId.get(r.from_person_id),
      to: byId.get(r.to_person_id),
      type: r.type,
      subtype: r.subtype,
      status: r.status,
      startDate: r.start_date,
      endDate: r.end_date,
      notes: r.notes,
    })),
    events: events.map((e) => ({
      id: e.public_id,
      person: byId.get(e.person_id),
      relatedPerson: e.related_person_id ? byId.get(e.related_person_id) : null,
      type: e.type,
      title: e.title,
      description: e.description,
      date: e.event_date,
      place: e.place,
    })),
  };

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'export', entityId: ownerId, entityLabel: owner.display_name,
    action: 'Tree Exported', newValue: 'json',
    detail: `${persons.length} person(s), ${relationships.length} relationship(s).`, ip: ctx.ip,
  });

  const body = JSON.stringify(payload, null, 2);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="family-tree-${owner.display_name.replace(/\W+/g, '-').toLowerCase()}.json"`,
    'Content-Length': Buffer.byteLength(body),
  });
  ctx.res.end(body);
  return undefined;
});

// ---------------------------------------------------------------- GEDCOM ---

/** Formats a date the way GEDCOM expects: "12 MAR 1948". */
function gedcomDate(iso, precision = 'exact') {
  if (!iso) return null;
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const [y, m, d] = String(iso).split('-');
  if (precision === 'year' || !m) return y;
  if (precision === 'month' || !d) return `${MONTHS[Number(m) - 1]} ${y}`;
  const formatted = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  return precision === 'about' ? `ABT ${formatted}` : formatted;
}

router.get('/tree.ged', async (ctx) => {
  const ownerId = ctx.user.id;
  const { persons, relationships, events } = collectTree(ctx, ownerId);
  const owner = get(`SELECT display_name FROM users WHERE id = ?`, ownerId);

  const indexOf = new Map(persons.map((p, i) => [p.id, `I${i + 1}`]));
  const lines = [];

  lines.push('0 HEAD');
  lines.push('1 SOUR GlobalFamilyTree');
  lines.push('2 NAME Global Family Tree & Ancestry Mapping System');
  lines.push('2 VERS 1.0.0');
  lines.push(`1 DATE ${gedcomDate(new Date().toISOString().slice(0, 10))}`);
  lines.push('1 CHAR UTF-8');
  lines.push('1 GEDC');
  lines.push('2 VERS 5.5.1');
  lines.push('2 FORM LINEAGE-LINKED');
  lines.push(`1 NOTE Exported for ${owner.display_name}. Only verified relationships are marked as such.`);

  // Individuals.
  for (const person of persons) {
    const view = viewPerson(ctx.user, person);
    const ref = indexOf.get(person.id);
    lines.push(`0 @${ref}@ INDI`);
    lines.push(`1 NAME ${person.given_name ?? ''} /${person.family_name ?? ''}/`);
    if (person.gender === 'male') lines.push('1 SEX M');
    else if (person.gender === 'female') lines.push('1 SEX F');
    else lines.push('1 SEX U');

    if (view.birthDate || view.birthYear) {
      lines.push('1 BIRT');
      const date = gedcomDate(view.birthDate, view.birthPrecision) ?? String(view.birthYear);
      if (date) lines.push(`2 DATE ${date}`);
      if (view.birthPlace) lines.push(`2 PLAC ${view.birthPlace}`);
    }
    if (view.deathDate) {
      lines.push('1 DEAT');
      lines.push(`2 DATE ${gedcomDate(view.deathDate, view.deathPrecision)}`);
      if (view.deathPlace) lines.push(`2 PLAC ${view.deathPlace}`);
    } else if (person.is_living === 0) {
      lines.push('1 DEAT Y');
    }
    if (view.occupation) lines.push(`1 OCCU ${view.occupation}`);
    if (view.notes) lines.push(`1 NOTE ${String(view.notes).replace(/\r?\n/g, ' ')}`);
    if (person.is_synthetic) lines.push(`1 NOTE ${config.syntheticLabel}`);

    for (const event of events.filter((e) => e.person_id === person.id)) {
      lines.push('1 EVEN');
      lines.push(`2 TYPE ${event.type}`);
      if (event.event_date) lines.push(`2 DATE ${gedcomDate(event.event_date, event.date_precision)}`);
      if (event.place) lines.push(`2 PLAC ${event.place}`);
      lines.push(`2 NOTE ${event.title}`);
    }
  }

  // Families: GEDCOM groups a couple and their children into a FAM record.
  // Build them from spouse edges, then attach children by shared parents.
  const families = [];
  const spouseEdges = relationships.filter((r) => r.type === 'spouse');
  const parentEdges = relationships.filter((r) => r.type === 'parent');

  const familyKey = (a, b) => [a, b].sort((x, y) => x - y).join(':');
  const familyByKey = new Map();

  for (const edge of spouseEdges) {
    const key = familyKey(edge.from_person_id, edge.to_person_id);
    if (familyByKey.has(key)) continue;
    const fam = {
      ref: `F${families.length + 1}`,
      husband: null, wife: null, children: new Set(),
      marriageDate: edge.start_date, divorceDate: edge.end_date, status: edge.status,
    };
    for (const id of [edge.from_person_id, edge.to_person_id]) {
      const p = persons.find((x) => x.id === id);
      if (!p) continue;
      if (p.gender === 'female' && !fam.wife) fam.wife = id;
      else if (!fam.husband) fam.husband = id;
      else fam.wife = id;
    }
    familyByKey.set(key, fam);
    families.push(fam);
  }

  // Children: group by their set of parents.
  const parentsOfChild = new Map();
  for (const edge of parentEdges) {
    if (!parentsOfChild.has(edge.to_person_id)) parentsOfChild.set(edge.to_person_id, []);
    parentsOfChild.get(edge.to_person_id).push(edge.from_person_id);
  }

  for (const [childId, parentIds] of parentsOfChild) {
    if (parentIds.length >= 2) {
      const key = familyKey(parentIds[0], parentIds[1]);
      let fam = familyByKey.get(key);
      if (!fam) {
        fam = { ref: `F${families.length + 1}`, husband: null, wife: null, children: new Set() };
        for (const id of parentIds.slice(0, 2)) {
          const p = persons.find((x) => x.id === id);
          if (p?.gender === 'female' && !fam.wife) fam.wife = id;
          else if (!fam.husband) fam.husband = id;
          else fam.wife = id;
        }
        familyByKey.set(key, fam);
        families.push(fam);
      }
      fam.children.add(childId);
    } else {
      // Single recorded parent still needs a FAM record to hold the link.
      const key = `solo:${parentIds[0]}`;
      let fam = familyByKey.get(key);
      if (!fam) {
        const p = persons.find((x) => x.id === parentIds[0]);
        fam = {
          ref: `F${families.length + 1}`,
          husband: p?.gender === 'female' ? null : parentIds[0],
          wife: p?.gender === 'female' ? parentIds[0] : null,
          children: new Set(),
        };
        familyByKey.set(key, fam);
        families.push(fam);
      }
      fam.children.add(childId);
    }
  }

  for (const fam of families) {
    lines.push(`0 @${fam.ref}@ FAM`);
    if (fam.husband && indexOf.has(fam.husband)) lines.push(`1 HUSB @${indexOf.get(fam.husband)}@`);
    if (fam.wife && indexOf.has(fam.wife)) lines.push(`1 WIFE @${indexOf.get(fam.wife)}@`);
    for (const child of fam.children) {
      if (indexOf.has(child)) lines.push(`1 CHIL @${indexOf.get(child)}@`);
    }
    if (fam.marriageDate) {
      lines.push('1 MARR');
      lines.push(`2 DATE ${gedcomDate(fam.marriageDate)}`);
    }
    if (fam.divorceDate) {
      lines.push('1 DIV');
      lines.push(`2 DATE ${gedcomDate(fam.divorceDate)}`);
    }
    if (fam.status && fam.status !== 'verified') {
      lines.push(`1 NOTE Relationship status in source system: ${fam.status}`);
    }
  }

  lines.push('0 TRLR');

  const body = `${lines.join('\r\n')}\r\n`;

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'export', entityId: ownerId, entityLabel: owner.display_name,
    action: 'Tree Exported', newValue: 'gedcom',
    detail: `${persons.length} individual(s), ${families.length} family record(s).`, ip: ctx.ip,
  });

  ctx.res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'attachment; filename="family-tree.ged"',
    'Content-Length': Buffer.byteLength(body),
  });
  ctx.res.end(body);
  return undefined;
});

// ------------------------------------------------------------------- SVG ---

/**
 * Renders the tree as an SVG document. The browser converts it to PNG or PDF,
 * which keeps this endpoint free of any rendering dependency.
 */
router.get('/tree.svg', async (ctx) => {
  const focusId = ctx.query.focus;
  const person = focusId
    ? get(`SELECT * FROM persons WHERE public_id = ?`, focusId)
    : get(`SELECT * FROM persons WHERE id = ?`, ctx.user.selfPersonId);
  if (!person) throw notFound('Nothing to export yet.');
  if (!canViewPerson(ctx.user, person)) throw notFound('Nothing to export yet.');

  const up = Math.min(6, Number.parseInt(ctx.query.up ?? '3', 10) || 3);
  const down = Math.min(6, Number.parseInt(ctx.query.down ?? '2', 10) || 2);

  const graph = loadGraph({ statuses: ['verified', 'unverified'] });
  const window = expandAround(graph, person.id, { up, down, nodeCap: 400 });

  // Lay out by generation band, evenly spaced.
  const byGeneration = new Map();
  for (const [id, info] of window.nodes) {
    const row = get(`SELECT * FROM persons WHERE id = ?`, id);
    if (!row) continue;
    const view = viewPerson(ctx.user, row);
    if (!view) continue;
    if (!byGeneration.has(info.generation)) byGeneration.set(info.generation, []);
    byGeneration.get(info.generation).push({ id, view });
  }

  const CARD_W = 190;
  const CARD_H = 66;
  const GAP_X = 26;
  const GAP_Y = 120;
  const MARGIN = 50;

  const generations = [...byGeneration.keys()].sort((a, b) => b - a);
  const positions = new Map();
  let maxWidth = 0;

  generations.forEach((generation, rowIndex) => {
    const people = byGeneration.get(generation);
    const rowWidth = people.length * CARD_W + (people.length - 1) * GAP_X;
    maxWidth = Math.max(maxWidth, rowWidth);
    people.forEach((entry, colIndex) => {
      positions.set(entry.id, {
        x: colIndex * (CARD_W + GAP_X),
        y: rowIndex * (CARD_H + GAP_Y),
        rowWidth,
        view: entry.view,
        generation,
      });
    });
  });

  // Centre each row.
  for (const pos of positions.values()) pos.x += (maxWidth - pos.rowWidth) / 2;

  const width = maxWidth + MARGIN * 2;
  const height = generations.length * (CARD_H + GAP_Y) + MARGIN * 2;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${MARGIN}" y="28" font-size="17" font-weight="600" fill="#1f2937">Family tree of ${escapeHtml(viewPerson(ctx.user, person).displayName)}</text>`);
  parts.push(`<text x="${MARGIN}" y="46" font-size="11" fill="#6b7280">Exported ${new Date().toISOString().slice(0, 10)} · ${positions.size} people · solid = verified, dashed = unverified</text>`);

  // Edges first so cards draw on top.
  for (const edge of window.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;
    const x1 = a.x + CARD_W / 2 + MARGIN;
    const y1 = a.y + CARD_H + MARGIN;
    const x2 = b.x + CARD_W / 2 + MARGIN;
    const y2 = b.y + MARGIN;
    const dash = edge.status === 'verified' ? '' : ' stroke-dasharray="5 4"';
    const colour = edge.dir === 'spouse' ? '#c026d3' : edge.status === 'verified' ? '#0f766e' : '#9ca3af';

    if (edge.dir === 'spouse') {
      const ay = a.y + CARD_H / 2 + MARGIN;
      const by = b.y + CARD_H / 2 + MARGIN;
      parts.push(`<line x1="${a.x + CARD_W + MARGIN}" y1="${ay}" x2="${b.x + MARGIN}" y2="${by}" stroke="${colour}" stroke-width="2"${dash}/>`);
    } else {
      const midY = (y1 + y2) / 2;
      parts.push(`<path d="M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}" fill="none" stroke="${colour}" stroke-width="1.6"${dash}/>`);
    }
  }

  for (const [, pos] of positions) {
    const { view } = pos;
    const x = pos.x + MARGIN;
    const y = pos.y + MARGIN;
    const fill = view.gender === 'male' ? '#eff6ff' : view.gender === 'female' ? '#fdf2f8' : '#f8fafc';
    const stroke = view.gender === 'male' ? '#93c5fd' : view.gender === 'female' ? '#f9a8d4' : '#cbd5e1';
    const dates = [view.birthYear ?? '', view.deathDate ? `– ${String(view.deathDate).slice(0, 4)}` : '']
      .filter(Boolean).join(' ');

    parts.push(`<g>`);
    parts.push(`<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
    parts.push(`<text x="${x + 12}" y="${y + 26}" font-size="13" font-weight="600" fill="#111827">${escapeHtml(truncate(view.displayName, 24))}</text>`);
    if (dates) parts.push(`<text x="${x + 12}" y="${y + 44}" font-size="11" fill="#6b7280">${escapeHtml(dates)}</text>`);
    if (view.birthPlace) parts.push(`<text x="${x + 12}" y="${y + 58}" font-size="10" fill="#9ca3af">${escapeHtml(truncate(view.birthPlace, 28))}</text>`);
    if (view.isSynthetic) parts.push(`<text x="${x + CARD_W - 10}" y="${y + 15}" font-size="8" fill="#b45309" text-anchor="end">DEMO</text>`);
    parts.push(`</g>`);
  }

  parts.push('</svg>');
  const body = parts.join('\n');

  ctx.res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Disposition': ctx.query.download === 'true'
      ? 'attachment; filename="family-tree.svg"'
      : 'inline',
    'Content-Length': Buffer.byteLength(body),
  });
  ctx.res.end(body);
  return undefined;
});

const truncate = (text, max) => (String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text));

// ---------------------------------------------------------------- backup ---

router.get('/backup', async (ctx) => {
  const { persons, relationships, events } = collectTree(ctx, ctx.user.id);
  const byId = new Map(persons.map((p) => [p.id, p.public_id]));

  const payload = {
    format: 'global-family-tree-backup/v1',
    createdAt: new Date().toISOString(),
    owner: { id: ctx.user.publicId, name: ctx.user.displayName, email: ctx.user.email },
    privacy: privacyFor(ctx.user.id),
    // Raw rows, because this is the owner's own complete data.
    persons: persons.map((p) => ({
      publicId: p.public_id,
      givenName: p.given_name, middleName: p.middle_name, familyName: p.family_name,
      maidenName: p.maiden_name, gender: p.gender,
      birthDate: p.birth_date, birthPrecision: p.birth_precision, birthPlace: p.birth_place,
      deathDate: p.death_date, deathPrecision: p.death_precision, deathPlace: p.death_place,
      isLiving: p.is_living === 1, occupation: p.occupation, currentPlace: p.current_place,
      notes: p.notes, visibility: p.visibility, isSynthetic: p.is_synthetic === 1,
    })),
    relationships: relationships.map((r) => ({
      from: byId.get(r.from_person_id), to: byId.get(r.to_person_id),
      type: r.type, subtype: r.subtype, status: r.status,
      startDate: r.start_date, endDate: r.end_date, notes: r.notes,
    })),
    events: events.map((e) => ({
      person: byId.get(e.person_id), relatedPerson: e.related_person_id ? byId.get(e.related_person_id) : null,
      type: e.type, title: e.title, description: e.description,
      date: e.event_date, precision: e.date_precision, place: e.place, visibility: e.visibility,
    })),
  };

  logSecurity({ event: 'backup_downloaded', severity: 'warning', userId: ctx.user.id, ip: ctx.ip });
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'export', entityId: ctx.user.id, entityLabel: 'Full backup',
    action: 'Backup Downloaded',
    detail: `${persons.length} person(s), ${relationships.length} relationship(s).`, ip: ctx.ip,
  });

  const body = JSON.stringify(payload, null, 2);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="family-tree-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    'Content-Length': Buffer.byteLength(body),
  });
  ctx.res.end(body);
  return undefined;
});

// --------------------------------------------------------------- restore ---

/**
 * Restores a backup into the caller's own tree.
 *
 * Restored relationships come back as 'unverified' unless `keepStatus` is set,
 * which is deliberate: an import is a claim about the data, not a verification
 * of it. `mode: 'replace'` clears the existing tree first.
 */
router.post('/restore', async (ctx) => {
  const input = validate(ctx.body, {
    mode: { type: 'enum', values: ['merge', 'replace'], default: 'merge' },
    keepStatus: { type: 'bool', default: false },
    confirm: { type: 'bool', default: false },
  });

  const backup = ctx.body.backup;
  if (!backup || typeof backup !== 'object') throw badRequest('Include the backup file contents as "backup".');
  if (!String(backup.format ?? '').startsWith('global-family-tree')) {
    throw badRequest('That file is not a Global Family Tree backup.');
  }
  if (!Array.isArray(backup.persons)) throw badRequest('The backup has no person records.');

  if (input.mode === 'replace' && !input.confirm) {
    const existing = get(
      `SELECT COUNT(*) AS n FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL`,
      ctx.user.id
    )?.n ?? 0;
    throw badRequest(
      `Replace mode deletes the ${existing} person record(s) currently in your tree. Send confirm: true to proceed.`
    );
  }

  const result = transaction(() => {
    if (input.mode === 'replace') {
      run(
        `DELETE FROM persons WHERE created_by_user_id = ? AND id <> COALESCE((SELECT self_person_id FROM users WHERE id = ?), -1)`,
        ctx.user.id, ctx.user.id
      );
    }

    const idMap = new Map();
    let created = 0;

    for (const p of backup.persons) {
      const person = createPerson(
        {
          given_name: p.givenName ?? 'Unknown',
          middle_name: p.middleName ?? null,
          family_name: p.familyName ?? null,
          maiden_name: p.maidenName ?? null,
          gender: p.gender ?? 'unknown',
          birth_date: p.birthDate ?? null,
          birth_precision: p.birthPrecision ?? 'unknown',
          birth_place: p.birthPlace ?? null,
          death_date: p.deathDate ?? null,
          death_precision: p.deathPrecision ?? 'unknown',
          death_place: p.deathPlace ?? null,
          is_living: p.isLiving === false ? 0 : 1,
          occupation: p.occupation ?? null,
          current_place: p.currentPlace ?? null,
          notes: p.notes ?? null,
          visibility: p.visibility ?? 'family',
        },
        {
          ownerUserId: ctx.user.id,
          actor: ctx.user,
          ip: ctx.ip,
          isSynthetic: p.isSynthetic === true,
          dataLabel: p.isSynthetic ? config.syntheticLabel : null,
          detail: 'Restored from a backup file.',
        }
      );
      idMap.set(p.publicId, person.id);
      created += 1;
    }

    let links = 0;
    let skipped = 0;
    for (const r of backup.relationships ?? []) {
      const fromId = idMap.get(r.from);
      const toId = idMap.get(r.to);
      if (!fromId || !toId) { skipped += 1; continue; }
      try {
        createRelationship(
          {
            fromPersonId: fromId,
            toPersonId: toId,
            type: r.type,
            subtype: r.subtype,
            status: input.keepStatus ? r.status : 'unverified',
            startDate: r.startDate ?? null,
            endDate: r.endDate ?? null,
            notes: r.notes ?? null,
          },
          { actor: ctx.user, ip: ctx.ip, source: 'import', allowDirectVerify: input.keepStatus }
        );
        links += 1;
      } catch {
        skipped += 1;   // duplicate or cycle -- keep going, report the count
      }
    }

    let eventCount = 0;
    for (const e of backup.events ?? []) {
      const personId = idMap.get(e.person);
      if (!personId) continue;
      run(
        `INSERT INTO events (public_id, person_id, related_person_id, type, title, description,
                             event_date, date_precision, event_year, place, visibility, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newPublicId(), personId, e.relatedPerson ? idMap.get(e.relatedPerson) ?? null : null,
        e.type ?? 'other', e.title ?? 'Event', e.description ?? null,
        e.date ?? null, e.precision ?? 'unknown',
        e.date ? Number.parseInt(String(e.date).slice(0, 4), 10) : null,
        e.place ?? null, e.visibility ?? 'family', ctx.user.id
      );
      eventCount += 1;
    }

    return { created, links, skipped, eventCount };
  });

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'export', entityId: ctx.user.id, entityLabel: 'Restore',
    action: 'Backup Restored',
    detail: `${result.created} person(s), ${result.links} relationship(s), ${result.skipped} skipped.`, ip: ctx.ip,
  });

  return {
    ok: true,
    ...result,
    note: input.keepStatus
      ? 'Relationship statuses were preserved from the backup.'
      : 'Restored relationships are unverified. Verify them to use them in relationship discovery.',
  };
});

export default router;
