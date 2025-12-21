import "dotenv/config";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import express from "express";
import { Client } from "@notionhq/client";

const app = express();
const port = process.env.PORT || 5175;
const databaseId = process.env.NOTION_DATABASE_ID;
const notionApiKey = process.env.NOTION_API_KEY;
const keyDatabaseId = process.env.KEY_DB || process.env.NOTION_KEY_DATABASE_ID;

const notion = new Client({ auth: notionApiKey });
const NOTION_CACHE_TTL_MS = 5 * 60 * 1000;
const VOTE_UPDATE_CONCURRENCY = Math.max(
  1,
  Number(process.env.VOTE_UPDATE_CONCURRENCY ?? "2") || 2,
);
const VOTE_JOB_CONCURRENCY = Math.max(
  1,
  Number(process.env.VOTE_JOB_CONCURRENCY ?? "1") || 1,
);
const VOTE_RESULTS_DIR =
  process.env.VOTE_RESULTS_DIR ||
  path.resolve(process.cwd(), "server", "vote-results");
const MAX_NOTION_RETRIES = 3;

let cachedVotePropertyName = null;
let cachedVotePropertyNameExpiresAt = 0;
let cachedKeyDatabaseProperties = null;
let cachedKeyDatabasePropertiesExpiresAt = 0;
const voteJobQueue = [];
let activeVoteJobs = 0;

app.use(express.json({ limit: "200kb" }));
app.use(
  cors({
    origin: ["http://localhost:5173"],
  }),
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotionRetryable(error) {
  const status = error?.status;
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function getRetryDelay(error, attempt) {
  const retryAfterHeader = error?.headers?.["retry-after"];
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  const base = Math.min(1000 * 2 ** attempt, 4000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function withNotionRetry(task) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_NOTION_RETRIES; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isNotionRetryable(error) || attempt === MAX_NOTION_RETRIES) {
        throw error;
      }
      await sleep(getRetryDelay(error, attempt));
    }
  }
  throw lastError;
}

async function asyncPool(limit, list, iterator) {
  const results = [];
  const executing = [];

  for (const item of list) {
    const task = Promise.resolve().then(() => iterator(item));
    results.push(task);

    if (limit <= list.length) {
      const executingTask = task.then(() => {
        executing.splice(executing.indexOf(executingTask), 1);
      });
      executing.push(executingTask);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }

  return Promise.all(results);
}

function createJobId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function aggregateVotes(votes) {
  const totals = new Map();
  for (const vote of votes) {
    const current = totals.get(vote.id) ?? 0;
    totals.set(vote.id, current + vote.count);
  }
  return Array.from(totals, ([id, count]) => ({ id, count }));
}

async function persistVoteRecord(record) {
  await fs.mkdir(VOTE_RESULTS_DIR, { recursive: true });
  const filePath = path.join(VOTE_RESULTS_DIR, `${record.jobId}.json`);
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  return filePath;
}

async function updateVoteRecord(filePath, record) {
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
}

async function safeUpdateVoteRecord(filePath, record) {
  try {
    await updateVoteRecord(filePath, record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Vote record update error:", message);
  }
}

function enqueueVoteJob(job) {
  voteJobQueue.push(job);
  drainVoteQueue();
}

function drainVoteQueue() {
  while (activeVoteJobs < VOTE_JOB_CONCURRENCY && voteJobQueue.length > 0) {
    const job = voteJobQueue.shift();
    activeVoteJobs += 1;
    runVoteJob(job)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Vote job failed:", message);
      })
      .finally(() => {
        activeVoteJobs -= 1;
        drainVoteQueue();
      });
  }
}

function joinRichText(richTextArray) {
  return richTextArray.map((item) => item.plain_text).join("").trim();
}

function formatDate(dateRange) {
  if (!dateRange) {
    return "";
  }
  if (dateRange.end) {
    return `${dateRange.start} -> ${dateRange.end}`;
  }
  return dateRange.start || "";
}

function formatFormula(formula) {
  if (!formula) {
    return "";
  }
  switch (formula.type) {
    case "string":
      return formula.string || "";
    case "number":
      return formula.number?.toString() || "";
    case "boolean":
      return formula.boolean ? "Yes" : "No";
    case "date":
      return formatDate(formula.date);
    default:
      return "";
  }
}

function formatRollup(rollup) {
  if (!rollup) {
    return "";
  }
  switch (rollup.type) {
    case "number":
      return rollup.number?.toString() || "";
    case "date":
      return formatDate(rollup.date);
    case "array": {
      const values = rollup.array
        .map((item) => stringifyValue(formatProperty(item)))
        .filter(Boolean);
      return values.join(", ");
    }
    default:
      return "";
  }
}

function stringifyValue(value) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value || "";
}

function formatProperty(property) {
  switch (property.type) {
    case "title":
      return joinRichText(property.title);
    case "rich_text":
      return joinRichText(property.rich_text);
    case "select":
      return property.select?.name || "";
    case "multi_select":
      return property.multi_select.map((item) => item.name).join(", ");
    case "number":
      return property.number?.toString() || "";
    case "date":
      return formatDate(property.date);
    case "checkbox":
      return property.checkbox ? "Yes" : "No";
    case "status":
      return property.status?.name || "";
    case "people":
      return property.people.map((person) => person.name || person.id).join(", ");
    case "files":
      return property.files
        .map((file) => file.file?.url || file.external?.url || file.name)
        .filter(Boolean);
    case "url":
      return property.url || "";
    case "email":
      return property.email || "";
    case "phone_number":
      return property.phone_number || "";
    case "relation":
      return property.relation.length
        ? `${property.relation.length} related`
        : "";
    case "formula":
      return formatFormula(property.formula);
    case "rollup":
      return formatRollup(property.rollup);
    case "created_time":
      return property.created_time || "";
    case "last_edited_time":
      return property.last_edited_time || "";
    default:
      return "";
  }
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

function getCoverUrl(cover) {
  if (!cover) {
    return "";
  }
  if (cover.type === "external") {
    return cover.external?.url || "";
  }
  if (cover.type === "file") {
    return cover.file?.url || "";
  }
  return "";
}

function normalizePage(page) {
  const entries = Object.entries(page.properties || {});
  const titleEntry = entries.find(([, property]) => property.type === "title");
  const title = titleEntry ? joinRichText(titleEntry[1].title) : "";

  const properties = entries
    .filter(([, property]) => property.type !== "title")
    .map(([name, property]) => ({
      name,
      type: property.type,
      value: formatProperty(property),
    }))
    .filter((property) => hasValue(property.value));

  return {
    id: page.id,
    title,
    cover: getCoverUrl(page.cover),
    properties,
  };
}

const KEY_VALUE_EXACT_NAMES = ["投票密码"];
const KEY_USED_EXACT_NAMES = ["是否已经使用？", "是否已经使用", "是否已使用", "是否使用"];
const KEY_RESULT_EXACT_NAMES = ["投票结果"];

const KEY_VALUE_MATCHERS = [
  "密码",
  "密钥",
  "口令",
  "key",
  "pass",
  "code",
  "token",
];
const KEY_USED_MATCHERS = ["使用", "已用", "已使用", "状态", "used", "status"];
const KEY_RESULT_MATCHERS = ["投票结果", "结果", "json", "vote", "result"];

function matchesPropertyName(name, matcher) {
  if (matcher instanceof RegExp) {
    return matcher.test(name);
  }
  return name.toLowerCase().includes(matcher.toLowerCase());
}

function findPropertyEntry(properties, matchers, allowedTypes) {
  return Object.entries(properties).find(([name, property]) => {
    if (allowedTypes && !allowedTypes.includes(property.type)) {
      return false;
    }
    return matchers.some((matcher) => matchesPropertyName(name, matcher));
  });
}

function isTruthyValue(value) {
  if (!value) {
    return false;
  }
  return /^(是|yes|true|已用|已使用|used)$/i.test(value.trim());
}

function getPropertyText(property) {
  if (!property) {
    return "";
  }
  switch (property.type) {
    case "title":
      return joinRichText(property.title);
    case "rich_text":
      return joinRichText(property.rich_text);
    case "select":
      return property.select?.name || "";
    case "status":
      return property.status?.name || "";
    case "number":
      return property.number?.toString() || "";
    case "checkbox":
      return property.checkbox ? "true" : "";
    default:
      return "";
  }
}

function isUsedPropertyValue(property) {
  if (!property) {
    return false;
  }
  switch (property.type) {
    case "checkbox":
      return property.checkbox;
    case "select":
      return isTruthyValue(property.select?.name || "");
    case "status":
      return isTruthyValue(property.status?.name || "");
    case "rich_text":
      return isTruthyValue(joinRichText(property.rich_text));
    case "title":
      return isTruthyValue(joinRichText(property.title));
    case "number":
      return (property.number ?? 0) > 0;
    default:
      return false;
  }
}

function resolveOptionName(propertySchema, preferredName) {
  const options =
    propertySchema.select?.options ?? propertySchema.status?.options ?? [];
  if (!Array.isArray(options) || options.length === 0) {
    return preferredName;
  }
  const exact = options.find((option) => option.name === preferredName);
  if (exact) {
    return exact.name;
  }
  const fallback = options.find((option) =>
    /是|yes|true|已用|已使用|used/i.test(option.name),
  );
  return (fallback ?? options[0]).name;
}

function buildUsedUpdate(propertySchema) {
  switch (propertySchema.type) {
    case "checkbox":
      return { checkbox: true };
    case "select":
      return { select: { name: resolveOptionName(propertySchema, "是") } };
    case "status":
      return { status: { name: resolveOptionName(propertySchema, "是") } };
    case "rich_text":
      return { rich_text: [{ text: { content: "是" } }] };
    case "title":
      return { title: [{ text: { content: "是" } }] };
    default:
      throw new Error(`Unsupported used property type: ${propertySchema.type}`);
  }
}

function buildResultUpdate(propertySchema, content) {
  const MAX_RESULT_CHUNK_LENGTH = 1900;
  const MAX_RESULT_CHUNKS = 100;
  const safeContent = content ?? "";
  const chunks = [];

  for (
    let index = 0;
    index < safeContent.length && chunks.length < MAX_RESULT_CHUNKS;
    index += MAX_RESULT_CHUNK_LENGTH
  ) {
    chunks.push(safeContent.slice(index, index + MAX_RESULT_CHUNK_LENGTH));
  }

  if (
    safeContent.length > MAX_RESULT_CHUNK_LENGTH * MAX_RESULT_CHUNKS &&
    chunks.length > 0
  ) {
    const suffix = "...";
    const lastIndex = chunks.length - 1;
    const trimmed = chunks[lastIndex].slice(
      0,
      Math.max(0, MAX_RESULT_CHUNK_LENGTH - suffix.length),
    );
    chunks[lastIndex] = `${trimmed}${suffix}`;
  }

  const richText = chunks.map((chunk) => ({ text: { content: chunk } }));

  switch (propertySchema.type) {
    case "rich_text":
      return { rich_text: richText };
    case "title":
      return { title: richText };
    default:
      throw new Error(
        `Result property must be rich_text or title (got ${propertySchema.type}).`,
      );
  }
}

function buildKeyFilter(propertyName, propertySchema, keyValue) {
  switch (propertySchema.type) {
    case "title":
      return { property: propertyName, title: { equals: keyValue } };
    case "rich_text":
      return { property: propertyName, rich_text: { equals: keyValue } };
    case "select":
      return { property: propertyName, select: { equals: keyValue } };
    case "number": {
      const numeric = Number(keyValue);
      if (Number.isFinite(numeric)) {
        return { property: propertyName, number: { equals: numeric } };
      }
      return null;
    }
    default:
      return null;
  }
}

async function queryDatabasePages(databaseId, filter) {
  const pages = [];
  let cursor;
  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      ...(filter ? { filter } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return pages;
}

async function fetchKeyDatabaseProperties() {
  if (!keyDatabaseId) {
    throw new Error("Missing KEY_DB configuration.");
  }
  if (Date.now() < cachedKeyDatabasePropertiesExpiresAt) {
    return cachedKeyDatabaseProperties;
  }
  const database = await withNotionRetry(() =>
    notion.databases.retrieve({
      database_id: keyDatabaseId,
    }),
  );
  cachedKeyDatabaseProperties = database.properties || {};
  cachedKeyDatabasePropertiesExpiresAt = Date.now() + NOTION_CACHE_TTL_MS;
  return cachedKeyDatabaseProperties;
}

function resolveKeyProperty(properties) {
  const override =
    process.env.KEY_DB_KEY_PROPERTY || process.env.KEY_DB_PASSWORD_PROPERTY;
  if (override && properties[override]) {
    return { name: override, schema: properties[override] };
  }
  const exact = KEY_VALUE_EXACT_NAMES.find((name) => properties[name]);
  if (exact) {
    return { name: exact, schema: properties[exact] };
  }
  let entry = findPropertyEntry(properties, KEY_VALUE_MATCHERS, [
    "title",
    "rich_text",
    "select",
    "number",
  ]);
  if (!entry) {
    entry = Object.entries(properties).find(
      ([, property]) => property.type === "title",
    );
  }
  if (!entry) {
    entry = Object.entries(properties).find(
      ([, property]) => property.type === "rich_text",
    );
  }
  if (!entry) {
    throw new Error("Unable to locate key property in key_db.");
  }
  return { name: entry[0], schema: entry[1] };
}

function resolveUsedProperty(properties) {
  const override = process.env.KEY_DB_USED_PROPERTY;
  if (override && properties[override]) {
    return { name: override, schema: properties[override] };
  }
  const exact = KEY_USED_EXACT_NAMES.find((name) => properties[name]);
  if (exact) {
    return { name: exact, schema: properties[exact] };
  }
  const entry = findPropertyEntry(properties, KEY_USED_MATCHERS, [
    "checkbox",
    "select",
    "status",
    "rich_text",
    "title",
    "number",
  ]);
  if (!entry) {
    throw new Error("Unable to locate used flag property in key_db.");
  }
  return { name: entry[0], schema: entry[1] };
}

function resolveResultProperty(properties, keyPropertyName, usedPropertyName) {
  const override = process.env.KEY_DB_RESULT_PROPERTY;
  if (override && properties[override]) {
    return { name: override, schema: properties[override] };
  }
  const exact = KEY_RESULT_EXACT_NAMES.find((name) => properties[name]);
  if (exact) {
    return { name: exact, schema: properties[exact] };
  }
  let entry = findPropertyEntry(properties, KEY_RESULT_MATCHERS, [
    "rich_text",
    "title",
  ]);
  if (!entry) {
    entry = Object.entries(properties).find(
      ([name, property]) =>
        property.type === "rich_text" &&
        name !== keyPropertyName &&
        name !== usedPropertyName,
    );
  }
  if (!entry) {
    throw new Error("Unable to locate vote result property in key_db.");
  }
  return { name: entry[0], schema: entry[1] };
}

async function findKeyPageByValue(keyValue, keyProperty) {
  const filter = buildKeyFilter(keyProperty.name, keyProperty.schema, keyValue);
  const pages = await queryDatabasePages(keyDatabaseId, filter);
  if (filter) {
    return pages[0] ?? null;
  }
  return (
    pages.find(
      (page) =>
        getPropertyText(page.properties?.[keyProperty.name]) === keyValue,
    ) ?? null
  );
}

async function updateKeyResults(keyId, resultsPayload, options = {}) {
  const properties = options.properties ?? (await fetchKeyDatabaseProperties());
  const keyProperty = resolveKeyProperty(properties);
  const usedProperty = resolveUsedProperty(properties);
  const resultProperty = resolveResultProperty(
    properties,
    keyProperty.name,
    usedProperty.name,
  );
  const content = JSON.stringify(resultsPayload ?? {});
  const update = buildResultUpdate(resultProperty.schema, content);
  await withNotionRetry(() =>
    notion.pages.update({
      page_id: keyId,
      properties: {
        [resultProperty.name]: update,
      },
    }),
  );
}

async function markKeyUsed(keyId, options = {}) {
  const properties = options.properties ?? (await fetchKeyDatabaseProperties());
  const usedProperty = resolveUsedProperty(properties);
  const usedUpdate = buildUsedUpdate(usedProperty.schema);
  await withNotionRetry(() =>
    notion.pages.update({
      page_id: keyId,
      properties: {
        [usedProperty.name]: usedUpdate,
      },
    }),
  );
}

async function resolveVotePropertyName() {
  if (process.env.NOTION_VOTE_PROPERTY) {
    return process.env.NOTION_VOTE_PROPERTY;
  }
  if (Date.now() < cachedVotePropertyNameExpiresAt) {
    return cachedVotePropertyName;
  }
  const database = await withNotionRetry(() =>
    notion.databases.retrieve({
      database_id: databaseId,
    }),
  );
  const properties = Object.entries(database.properties || {}).filter(
    ([, property]) => property.type === "number",
  );
  if (properties.length === 0) {
    throw new Error("No number property found for votes.");
  }
  const voteMatcher = /vote|票|得票|投票/i;
  const matched = properties.find(([name]) => voteMatcher.test(name));
  cachedVotePropertyName = (matched ?? properties[0])[0];
  cachedVotePropertyNameExpiresAt = Date.now() + NOTION_CACHE_TTL_MS;
  return cachedVotePropertyName;
}

async function performVoteUpdate({ keyId, aggregatedVotes, resultsPayload }) {
  let keyProperties = null;
  let usedProperty = null;

  if (keyDatabaseId && keyId) {
    keyProperties = await fetchKeyDatabaseProperties();
    usedProperty = resolveUsedProperty(keyProperties);
    const keyPage = await withNotionRetry(() =>
      notion.pages.retrieve({ page_id: keyId }),
    );
    if (isUsedPropertyValue(keyPage.properties?.[usedProperty.name])) {
      throw new Error("Key already used.");
    }
  }

  let votePropertyName = null;
  const results = [];

  if (aggregatedVotes.length > 0) {
    votePropertyName = await resolveVotePropertyName();
    const updateResults = await asyncPool(
      Math.min(VOTE_UPDATE_CONCURRENCY, aggregatedVotes.length),
      aggregatedVotes,
      async (vote) => {
        const page = await withNotionRetry(() =>
          notion.pages.retrieve({ page_id: vote.id }),
        );
        const property = page.properties?.[votePropertyName];
        if (!property || property.type !== "number") {
          throw new Error(
            `Vote property "${votePropertyName}" is not numeric.`,
          );
        }
        const currentValue = property.number ?? 0;
        const nextValue = currentValue + vote.count;

        await withNotionRetry(() =>
          notion.pages.update({
            page_id: vote.id,
            properties: {
              [votePropertyName]: { number: nextValue },
            },
          }),
        );

        return {
          id: vote.id,
          previous: currentValue,
          next: nextValue,
        };
      },
    );
    results.push(...updateResults);
  }

  let resultsSaved = false;
  let resultsError = null;

  if (keyDatabaseId && keyId) {
    try {
      await updateKeyResults(keyId, resultsPayload, {
        properties: keyProperties ?? undefined,
      });
      resultsSaved = true;
    } catch (error) {
      resultsError =
        error instanceof Error ? error.message : "Unknown Notion error.";
      console.error("Key result update error:", resultsError);
    }

    try {
      await markKeyUsed(keyId, { properties: keyProperties ?? undefined });
    } catch (error) {
      const usedError =
        error instanceof Error ? error.message : "Unknown Notion error.";
      console.error("Key used update error:", usedError);
      resultsError = resultsError ? `${resultsError}; ${usedError}` : usedError;
    }
  }

  return {
    updated: results.length,
    property: votePropertyName ?? undefined,
    results,
    resultsSaved,
    resultsError,
  };
}

async function runVoteJob(job) {
  const startedAt = new Date().toISOString();
  job.record = { ...job.record, status: "processing", startedAt };
  await safeUpdateVoteRecord(job.recordPath, job.record);

  try {
    const result = await performVoteUpdate(job);
    job.record = {
      ...job.record,
      status: "completed",
      completedAt: new Date().toISOString(),
      updateResult: result,
    };
    await safeUpdateVoteRecord(job.recordPath, job.record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.record = {
      ...job.record,
      status: "failed",
      failedAt: new Date().toISOString(),
      error: message,
    };
    await safeUpdateVoteRecord(job.recordPath, job.record);
    console.error(`Vote update failed for job ${job.jobId}:`, message);
  }
}

app.get("/api/notion", async (_req, res) => {
  if (!databaseId || !notionApiKey) {
    res.status(500).json({
      error: "Missing Notion config",
      message: "Set NOTION_DATABASE_ID and NOTION_API_KEY in .env",
    });
    return;
  }

  try {
    const response = await notion.databases.query({
      database_id: databaseId,
    });

    const items = response.results.map(normalizePage);

    res.json({ items });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Notion error.";
    console.error("Notion API error:", message);
    res.status(500).json({ error: "Notion request failed", message });
  }
});

app.post("/api/vote-key", async (req, res) => {
  if (!keyDatabaseId || !notionApiKey) {
    res.status(500).json({
      error: "Missing key database config",
      message: "Set KEY_DB and NOTION_API_KEY in .env",
    });
    return;
  }

  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  if (!key) {
    res.status(400).json({ error: "Missing key", message: "请输入投票密码。" });
    return;
  }

  try {
    const properties = await fetchKeyDatabaseProperties();
    const keyProperty = resolveKeyProperty(properties);
    const usedProperty = resolveUsedProperty(properties);
    const page = await findKeyPageByValue(key, keyProperty);

    if (!page) {
      res.status(404).json({ error: "Invalid key", message: "密码无效或不存在。" });
      return;
    }

    if (isUsedPropertyValue(page.properties?.[usedProperty.name])) {
      res.status(403).json({ error: "Key used", message: "该密码已使用。" });
      return;
    }

    res.json({ ok: true, keyId: page.id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Notion error.";
    console.error("Key validation error:", message);
    res.status(500).json({ error: "Key validation failed", message });
  }
});

app.post("/api/votes", async (req, res) => {
  if (!databaseId || !notionApiKey) {
    res.status(500).json({
      error: "Missing Notion config",
      message: "Set NOTION_DATABASE_ID and NOTION_API_KEY in .env",
    });
    return;
  }

  const keyId = typeof req.body?.keyId === "string" ? req.body.keyId : "";
  if (keyDatabaseId && !keyId) {
    res.status(400).json({
      error: "Missing vote key",
      message: "投票前需要输入密码。",
    });
    return;
  }

  const votes = Array.isArray(req.body?.votes) ? req.body.votes : [];
  const sanitizedVotes = votes
    .map((vote) => ({
      id: typeof vote?.id === "string" ? vote.id : "",
      count: Number.isFinite(vote?.count) ? Number(vote.count) : 0,
    }))
    .filter((vote) => vote.id && vote.count > 0);
  const aggregatedVotes = aggregateVotes(sanitizedVotes);
  const resultsPayload = req.body?.results ?? { votes: sanitizedVotes };
  const jobId = createJobId();
  const record = {
    jobId,
    receivedAt: new Date().toISOString(),
    status: "queued",
    keyId: keyId || null,
    votes: sanitizedVotes,
    results: resultsPayload,
  };

  try {
    const recordPath = await persistVoteRecord(record);
    enqueueVoteJob({
      jobId,
      keyId,
      aggregatedVotes,
      sanitizedVotes,
      resultsPayload,
      record,
      recordPath,
    });

    res.json({
      ok: true,
      queued: true,
      jobId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown storage error.";
    console.error("Vote record save error:", message);
    res.status(500).json({ error: "Vote record save failed", message });
  }
});

app.listen(port, () => {
  console.log(`Notion proxy listening on http://localhost:${port}`);
});
