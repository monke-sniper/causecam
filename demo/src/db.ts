import fs from 'node:fs';
import path from 'node:path';
import knex, { type Knex } from 'knex';

export const CURRENT_USER_ID = 1;

export async function openDb(file: string): Promise<Knex> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = knex({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true });

  if (!(await db.schema.hasTable('user_settings'))) {
    await db.schema.createTable('user_settings', (t) => {
      t.integer('user_id').primary();
      t.string('display_name').notNullable();
      t.string('timezone').notNullable();
      t.string('digest_frequency').notNullable();
      t.boolean('marketing_emails').notNullable().defaultTo(false);
      t.string('updated_at');
    });
  }
  const existing = await db('user_settings').where({ user_id: CURRENT_USER_ID }).first();
  if (!existing) {
    await db('user_settings').insert({
      user_id: CURRENT_USER_ID,
      display_name: 'Ada Lovelace',
      timezone: 'UTC',
      digest_frequency: 'weekly',
      marketing_emails: false,
      updated_at: new Date().toISOString(),
    });
  }
  return db;
}
