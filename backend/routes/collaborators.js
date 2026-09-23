/**
 * Family collaboration: inviting other registered users to contribute to a
 * tree, with a role that bounds exactly what they may do.
 *
 *   viewer    read only
 *   suggester read + propose people and relationships (always 'unverified')
 *   editor    read + create and edit records
 *   verifier  editor + approve or reject verification requests
 */
import { Router } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { all, get, run } from '../db/index.js';
import { recordChange, notify } from '../lib/audit.js';
import { clearAccessCache } from '../lib/privacy.js';
import { notFound, conflict, forbidden, badRequest } from '../lib/errors.js';

const router = new Router();

const ROLES = ['viewer', 'suggester', 'editor', 'verifier'];

const ROLE_DESCRIPTIONS = {
  viewer: 'Can see the tree, subject to each person’s visibility setting.',
  suggester: 'Can propose new people and relationships. Everything they add starts as unverified.',
  editor: 'Can add and edit people and relationships.',
  verifier: 'Everything an editor can do, plus approving or rejecting verification requests.',
};

function viewCollaborator(row, direction) {
  const other = get(
    `SELECT public_id, display_name FROM users WHERE id = ?`,
    direction === 'granted' ? row.grantee_user_id : row.owner_user_id
  );
  return {
    id: row.id,
    user: other ? { id: other.public_id, name: other.display_name } : null,
    role: row.role,
    roleDescription: ROLE_DESCRIPTIONS[row.role],
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    direction,
  };
}

// ------------------------------------------------------------------ list ---

router.get('/', async (ctx) => {
  const granted = all(
    `SELECT * FROM tree_collaborators WHERE owner_user_id = ? ORDER BY created_at DESC`,
    ctx.user.id
  );
  const received = all(
    `SELECT * FROM tree_collaborators WHERE grantee_user_id = ? ORDER BY created_at DESC`,
    ctx.user.id
  );

  return {
    /** People I have given access to my tree. */
    granted: granted.map((r) => viewCollaborator(r, 'granted')),
    /** Trees other people have given me access to. */
    received: received.map((r) => viewCollaborator(r, 'received')),
    roles: ROLES.map((role) => ({ role, description: ROLE_DESCRIPTIONS[role] })),
    pendingInvitations: received.filter((r) => r.status === 'pending').length,
  };
});

// ---------------------------------------------------------------- invite ---

router.post('/', async (ctx) => {
  const input = validate(ctx.body, {
    userId: { type: 'string', maxLength: 64 },
    email: { type: 'email' },
    role: { type: 'enum', values: ROLES, default: 'viewer', label: 'Role' },
    message: { type: 'string', maxLength: 500 },
  });

  if (!input.userId && !input.email) throw badRequest('Give the person’s user ID or email address.');

  const grantee = input.userId
    ? get(`SELECT * FROM users WHERE public_id = ? AND status = 'active'`, input.userId)
    : get(`SELECT * FROM users WHERE email = ? AND status = 'active'`, input.email);

  if (!grantee) throw notFound('No active account was found for that person.');
  if (grantee.id === ctx.user.id) throw badRequest('You already have full access to your own tree.');

  const existing = get(
    `SELECT * FROM tree_collaborators WHERE owner_user_id = ? AND grantee_user_id = ?`,
    ctx.user.id, grantee.id
  );

  if (existing && existing.status === 'active') {
    throw conflict(`${grantee.display_name} already has ${existing.role} access to your tree.`);
  }

  if (existing) {
    run(
      `UPDATE tree_collaborators
       SET role = ?, status = 'pending', message = ?, invited_by = ?, created_at = datetime('now'), responded_at = NULL
       WHERE id = ?`,
      input.role, input.message ?? null, ctx.user.id, existing.id
    );
  } else {
    run(
      `INSERT INTO tree_collaborators (owner_user_id, grantee_user_id, role, status, invited_by, message)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      ctx.user.id, grantee.id, input.role, ctx.user.id, input.message ?? null
    );
  }

  clearAccessCache();

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'collaborator', entityId: grantee.id, entityLabel: grantee.display_name,
    action: 'Collaborator Invited', newValue: input.role, ip: ctx.ip,
  });

  notify({
    userId: grantee.id, type: 'collaboration', severity: 'info',
    title: `${ctx.user.displayName} invited you to their family tree`,
    body: `${ROLE_DESCRIPTIONS[input.role]}${input.message ? ` -- "${input.message}"` : ''}`,
    link: '#/collaborators',
  });

  return {
    __status: 201,
    invitation: { user: grantee.display_name, role: input.role, status: 'pending' },
  };
});

// ---------------------------------------------------------- respond to it ---

router.post('/:id/accept', async (ctx) => {
  const row = get(`SELECT * FROM tree_collaborators WHERE id = ?`, Number(ctx.params.id));
  if (!row) throw notFound('Invitation not found.');
  if (row.grantee_user_id !== ctx.user.id) throw forbidden('That invitation is not addressed to you.');
  if (row.status !== 'pending') throw conflict(`That invitation was already ${row.status}.`);

  run(`UPDATE tree_collaborators SET status = 'active', responded_at = datetime('now') WHERE id = ?`, row.id);
  clearAccessCache();

  const owner = get(`SELECT display_name FROM users WHERE id = ?`, row.owner_user_id);
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'collaborator', entityId: row.id, entityLabel: owner?.display_name ?? 'tree',
    action: 'Collaboration Accepted', newValue: row.role, ip: ctx.ip,
  });
  notify({
    userId: row.owner_user_id, type: 'collaboration', severity: 'success',
    title: `${ctx.user.displayName} accepted your invitation`,
    body: `They now have ${row.role} access to your family tree.`,
    link: '#/collaborators',
  });

  return { ok: true, status: 'active', role: row.role };
});

router.post('/:id/decline', async (ctx) => {
  const row = get(`SELECT * FROM tree_collaborators WHERE id = ?`, Number(ctx.params.id));
  if (!row) throw notFound('Invitation not found.');
  if (row.grantee_user_id !== ctx.user.id) throw forbidden('That invitation is not addressed to you.');
  if (row.status !== 'pending') throw conflict(`That invitation was already ${row.status}.`);

  run(`UPDATE tree_collaborators SET status = 'declined', responded_at = datetime('now') WHERE id = ?`, row.id);
  clearAccessCache();

  notify({
    userId: row.owner_user_id, type: 'collaboration', severity: 'info',
    title: `${ctx.user.displayName} declined your invitation`,
    link: '#/collaborators',
  });

  return { ok: true, status: 'declined' };
});

// ------------------------------------------------------------ change role ---

router.patch('/:id', async (ctx) => {
  const row = get(`SELECT * FROM tree_collaborators WHERE id = ?`, Number(ctx.params.id));
  if (!row) throw notFound('Collaborator not found.');
  if (row.owner_user_id !== ctx.user.id) throw forbidden('Only the tree owner can change a collaborator’s role.');

  const input = validate(ctx.body, { role: { type: 'enum', values: ROLES, required: true, label: 'Role' } });
  if (input.role === row.role) return { ok: true, role: row.role, unchanged: true };

  run(`UPDATE tree_collaborators SET role = ? WHERE id = ?`, input.role, row.id);
  clearAccessCache();

  const grantee = get(`SELECT id, display_name FROM users WHERE id = ?`, row.grantee_user_id);
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'collaborator', entityId: row.id, entityLabel: grantee?.display_name ?? 'collaborator',
    action: 'Collaborator Role Changed', field: 'role', oldValue: row.role, newValue: input.role, ip: ctx.ip,
  });
  notify({
    userId: row.grantee_user_id, type: 'collaboration', severity: 'info',
    title: 'Your access level changed',
    body: `${ctx.user.displayName} set your role to ${input.role}. ${ROLE_DESCRIPTIONS[input.role]}`,
    link: '#/collaborators',
  });

  return { ok: true, role: input.role };
});

// ---------------------------------------------------------------- revoke ---

router.delete('/:id', async (ctx) => {
  const row = get(`SELECT * FROM tree_collaborators WHERE id = ?`, Number(ctx.params.id));
  if (!row) throw notFound('Collaborator not found.');

  const isOwner = row.owner_user_id === ctx.user.id;
  const isGrantee = row.grantee_user_id === ctx.user.id;
  if (!isOwner && !isGrantee) throw forbidden('That collaboration does not involve you.');

  run(`UPDATE tree_collaborators SET status = 'revoked', responded_at = datetime('now') WHERE id = ?`, row.id);
  clearAccessCache();

  const other = get(
    `SELECT id, display_name FROM users WHERE id = ?`,
    isOwner ? row.grantee_user_id : row.owner_user_id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'collaborator', entityId: row.id, entityLabel: other?.display_name ?? 'collaborator',
    action: isOwner ? 'Collaborator Removed' : 'Left Family Tree',
    oldValue: row.role, ip: ctx.ip,
  });

  if (other) {
    notify({
      userId: other.id, type: 'collaboration', severity: 'warning',
      title: isOwner ? 'Your access was removed' : `${ctx.user.displayName} left your family tree`,
      body: isOwner
        ? `${ctx.user.displayName} removed your access to their family tree.`
        : 'They no longer have access to your tree.',
      link: '#/collaborators',
    });
  }

  return { ok: true, status: 'revoked' };
});

export default router;
