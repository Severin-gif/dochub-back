import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { allowedOrigins, config } from "./config.js";
import { db, transaction } from "./db.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error("Origin is not allowed")); } }));
app.use(express.json({ limit: "2mb" }));

const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res, next)).catch(next); };
const uuid = z.string().uuid();
const projectInput = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).optional() });
const documentInput = z.object({ title: z.string().trim().min(1).max(180), content: z.string().max(2_000_000).default(""), path: z.string().trim().max(500).default("/") });
const saveInput = z.object({ content: z.string().max(2_000_000), version: z.number().int().positive(), message: z.string().trim().max(300).optional() });
const changeInput = z.object({ documentId: z.string().uuid(), title: z.string().trim().min(1).max(180), proposedContent: z.string().max(2_000_000), baseVersion: z.number().int().positive() });

app.get("/health", asyncRoute(async (_req, res) => { await db.query("SELECT 1"); res.json({ status: "ok", service: "dochub-back" }); }));

app.use("/api", asyncRoute(async (req, res, next) => {
  if (!config.ALLOW_DEMO_AUTH) return res.status(501).json({ error: "Подключите провайдер авторизации перед публичным запуском" });
  const email = String(req.header("X-User-Email") || config.DEMO_USER_EMAIL).toLowerCase();
  const result = await db.query("INSERT INTO users(email, name) VALUES($1, $2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id", [email, email === config.DEMO_USER_EMAIL ? "Демо-пользователь" : ""]);
  req.userId = result.rows[0].id;
  next();
}));

app.get("/api/projects", asyncRoute(async (req, res) => {
  const result = await db.query(`SELECT p.id,p.name,p.description,p.created_at AS "createdAt",p.updated_at AS "updatedAt",
    json_build_object('documents',(SELECT count(*)::int FROM documents d WHERE d.project_id=p.id),'changeRequests',(SELECT count(*)::int FROM change_requests c WHERE c.project_id=p.id AND c.status='OPEN')) AS _count
    FROM projects p WHERE p.owner_id=$1 ORDER BY p.updated_at DESC`, [req.userId]);
  res.json(result.rows);
}));

app.post("/api/projects", asyncRoute(async (req, res) => {
  const input = projectInput.parse(req.body);
  const result = await db.query(`INSERT INTO projects(owner_id,name,description) VALUES($1,$2,$3) RETURNING id,name,description,created_at AS "createdAt",updated_at AS "updatedAt"`, [req.userId, input.name, input.description || null]);
  res.status(201).json(result.rows[0]);
}));

app.get("/api/projects/:projectId/documents", asyncRoute(async (req, res) => {
  const projectId = uuid.parse(req.params.projectId);
  const result = await db.query(`SELECT d.id,d.project_id AS "projectId",d.title,d.path,d.content,d.version,d.updated_at AS "updatedAt" FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.project_id=$1 AND p.owner_id=$2 ORDER BY d.path,d.title`, [projectId, req.userId]);
  res.json(result.rows);
}));

app.post("/api/projects/:projectId/documents", asyncRoute(async (req, res) => {
  const projectId = uuid.parse(req.params.projectId); const input = documentInput.parse(req.body);
  const item = await transaction(async (client) => {
    const owner = await client.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [projectId, req.userId]);
    if (!owner.rowCount) throw Object.assign(new Error("Проект не найден"), { status: 404 });
    const result = await client.query(`INSERT INTO documents(project_id,title,path,content) VALUES($1,$2,$3,$4) RETURNING id,project_id AS "projectId",title,path,content,version,updated_at AS "updatedAt"`, [projectId, input.title, input.path, input.content]);
    await client.query("INSERT INTO document_versions(document_id,version,content,author_id,message) VALUES($1,1,$2,$3,'Создан документ')", [result.rows[0].id, input.content, req.userId]);
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [projectId]);
    return result.rows[0];
  });
  res.status(201).json(item);
}));

app.put("/api/documents/:id", asyncRoute(async (req, res) => {
  const id = uuid.parse(req.params.id); const input = saveInput.parse(req.body);
  const item = await transaction(async (client) => {
    const found = await client.query(`SELECT d.*,p.owner_id FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 FOR UPDATE`, [id]);
    if (!found.rowCount || found.rows[0].owner_id !== req.userId) throw Object.assign(new Error("Документ не найден"), { status: 404 });
    if (found.rows[0].version !== input.version) throw Object.assign(new Error("Документ уже изменён. Обновите страницу."), { status: 409 });
    const nextVersion = input.version + 1;
    const result = await client.query(`UPDATE documents SET content=$1,version=$2,updated_at=now() WHERE id=$3 RETURNING id,project_id AS "projectId",title,path,content,version,updated_at AS "updatedAt"`, [input.content, nextVersion, id]);
    await client.query("INSERT INTO document_versions(document_id,version,content,author_id,message) VALUES($1,$2,$3,$4,$5)", [id, nextVersion, input.content, req.userId, input.message || "Сохранена редакция"]);
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [found.rows[0].project_id]);
    return result.rows[0];
  });
  res.json(item);
}));

app.get("/api/projects/:projectId/change-requests", asyncRoute(async (req, res) => {
  const projectId = uuid.parse(req.params.projectId);
  const result = await db.query(`SELECT c.id,c.title,c.status,c.base_version AS "baseVersion",c.proposed_content AS "proposedContent",c.created_at AS "createdAt",json_build_object('id',d.id,'title',d.title,'version',d.version) AS document FROM change_requests c JOIN documents d ON d.id=c.document_id JOIN projects p ON p.id=c.project_id WHERE c.project_id=$1 AND p.owner_id=$2 ORDER BY c.created_at DESC`, [projectId, req.userId]);
  res.json(result.rows);
}));

app.post("/api/change-requests", asyncRoute(async (req, res) => {
  const input = changeInput.parse(req.body);
  const found = await db.query(`SELECT d.project_id,d.version,p.owner_id FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1`, [input.documentId]);
  if (!found.rowCount || found.rows[0].owner_id !== req.userId) return res.status(404).json({ error: "Документ не найден" });
  if (found.rows[0].version !== input.baseVersion) return res.status(409).json({ error: "Редакция устарела. Обновите документ." });
  const result = await db.query(`INSERT INTO change_requests(project_id,document_id,author_id,title,base_version,proposed_content) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,status,base_version AS "baseVersion",proposed_content AS "proposedContent",created_at AS "createdAt"`, [found.rows[0].project_id, input.documentId, req.userId, input.title, input.baseVersion, input.proposedContent]);
  res.status(201).json(result.rows[0]);
}));

app.post("/api/change-requests/:id/merge", asyncRoute(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const result = await transaction(async (client) => {
    const found = await client.query(`SELECT c.*,d.version,d.project_id,p.owner_id FROM change_requests c JOIN documents d ON d.id=c.document_id JOIN projects p ON p.id=c.project_id WHERE c.id=$1 FOR UPDATE`, [id]);
    if (!found.rowCount || found.rows[0].owner_id !== req.userId) throw Object.assign(new Error("Запрос не найден"), { status: 404 });
    const item = found.rows[0];
    if (item.status !== "OPEN") throw Object.assign(new Error("Запрос уже обработан"), { status: 409 });
    if (item.version !== item.base_version) throw Object.assign(new Error("Конфликт редакций: документ был изменён"), { status: 409 });
    const nextVersion = item.version + 1;
    await client.query("UPDATE documents SET content=$1,version=$2,updated_at=now() WHERE id=$3", [item.proposed_content, nextVersion, item.document_id]);
    await client.query("INSERT INTO document_versions(document_id,version,content,author_id,message) VALUES($1,$2,$3,$4,$5)", [item.document_id, nextVersion, item.proposed_content, req.userId, `Приняты правки: ${item.title}`]);
    const updated = await client.query(`UPDATE change_requests SET status='MERGED',updated_at=now() WHERE id=$1 RETURNING id,title,status,base_version AS "baseVersion",proposed_content AS "proposedContent",created_at AS "createdAt"`, [id]);
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [item.project_id]);
    return updated.rows[0];
  });
  res.json(result);
}));

app.post("/api/change-requests/:id/close", asyncRoute(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const result = await db.query(`UPDATE change_requests c SET status='CLOSED',updated_at=now() FROM projects p WHERE c.id=$1 AND c.project_id=p.id AND p.owner_id=$2 AND c.status='OPEN' RETURNING c.id,c.title,c.status,c.base_version AS "baseVersion",c.proposed_content AS "proposedContent",c.created_at AS "createdAt"`, [id, req.userId]);
  if (!result.rowCount) return res.status(404).json({ error: "Открытый запрос не найден" });
  res.json(result.rows[0]);
}));

app.use((_req, res) => res.status(404).json({ error: "Маршрут не найден" }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Проверьте заполнение полей", details: z.treeifyError(error) });
  const known = error as { status?: number; message?: string };
  console.error(error);
  res.status(known.status || 500).json({ error: known.status ? known.message : "Внутренняя ошибка сервера" });
});

const server = app.listen(config.PORT, "0.0.0.0", () => console.log(`DocHub API listening on ${config.PORT}`));
const shutdown = () => server.close(() => db.end().finally(() => process.exit(0)));
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
