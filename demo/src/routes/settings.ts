import { Router } from 'express';
import type { Knex } from 'knex';
import { CURRENT_USER_ID } from '../db';
import { fromSettingsRow, toSettingsRow, validateSettingsInput, type SettingsRow } from '../settings-transform';

export function settingsRouter(db: Knex): Router {
  const router = Router();

  router.get('/settings', async (_req, res) => {
    const row = await db<SettingsRow>('user_settings').where({ user_id: CURRENT_USER_ID }).first();
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(fromSettingsRow(row));
  });

  router.put('/settings', async (req, res) => {
    const result = validateSettingsInput(req.body);
    if (!result.ok) {
      res.status(400).json({ errors: result.errors });
      return;
    }
    const row = toSettingsRow(result.value);
    await db('user_settings').where({ user_id: CURRENT_USER_ID }).update(row);
    const saved = await db<SettingsRow>('user_settings').where({ user_id: CURRENT_USER_ID }).first();
    res.json(fromSettingsRow(saved!));
  });

  return router;
}
