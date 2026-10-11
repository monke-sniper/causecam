import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { openDb } from './db';
import { settingsRouter } from './routes/settings';

const PORT = Number(process.env.PORT ?? 4400);
const DB_FILE = process.env.DEMO_DB ?? path.join(__dirname, '..', 'data', 'demo.sqlite');

async function main(): Promise<void> {
  const db = await openDb(DB_FILE);
  const app = express();

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', settingsRouter(db));

  // Like many production apps, the error handler hides details from the client and logs nothing.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`demo app listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
