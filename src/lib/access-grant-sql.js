// Pending invitations must not replace an administrator who can already sign in.
const canRemoveAdmin = `
  (SELECT count(*) FROM access_grants WHERE role = 'admin') > 1
  AND (
    NOT EXISTS (
      SELECT 1 FROM auth_user
      WHERE lower(auth_user.email) = access_grants.email AND email_verified = 1
    )
    OR EXISTS (
      SELECT 1 FROM access_grants AS other_admin
      JOIN auth_user ON lower(auth_user.email) = other_admin.email
      WHERE other_admin.role = 'admin' AND auth_user.email_verified = 1
        AND other_admin.email <> access_grants.email
    )
  )`

export const grantAccessSql = `
INSERT INTO access_grants (email, role, updated_at) VALUES (?, ?, unixepoch())
ON CONFLICT(email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
WHERE excluded.role = 'admin' OR access_grants.role <> 'admin' OR (${canRemoveAdmin})
RETURNING email, role;`

export const revokeAccessSql = `
DELETE FROM access_grants WHERE email = ?
AND (role <> 'admin' OR (${canRemoveAdmin}))
RETURNING email;`
