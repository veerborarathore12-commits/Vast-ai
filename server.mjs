import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const usersFile = path.join(process.cwd(), "data", "users.json");
const databasePath = path.join(process.cwd(), "data", "vast.db");
const libraryDirectory = path.join(process.cwd(), "data", "library");
await fs.mkdir(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    profile_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS users_username_index ON users(username);
`);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const DAILY_IMAGE_LIMIT = 3;
const IMAGE_BUCKET = "vast-images";
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

app.use(express.json());

function imageUrlForClient(image) {
  return image.imagePath ? `/api/images/file/${image.id}` : image.imageUrl;
}

function imageMimeType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png";
}

async function createCloudflareImage(prompt, sourceImage) {
  const model = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
  const body = new FormData();
  body.append("prompt", prompt);
  body.append("width", "1024");
  body.append("height", "1024");
  if (sourceImage) body.append("input_image_0", new Blob([sourceImage.buffer], { type: sourceImage.mimeType }), "source-image.png");
  const modelPath = model.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${modelPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}` },
    body,
  });
  const data = await response.json().catch(() => ({}));
  const encodedImage = data.result?.image;
  if (!response.ok || !data.success || !encodedImage) {
    console.error("Cloudflare image request failed", response.status, data);
    throw new Error(data.errors?.[0]?.message || "Cloudflare could not create that image right now. Please try again.");
  }
  const buffer = Buffer.from(encodedImage, "base64");
  return { buffer, mimeType: imageMimeType(buffer) };
}

async function saveGeneratedImage(userId, image) {
  const id = crypto.randomUUID();
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png";
  const path = `${userId}/${id}.${extension}`;
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, image.buffer, {
    contentType: image.mimeType,
    upsert: false,
  });
  if (error) throw new Error("Vast could not save the image. Make sure the Supabase 'vast-images' storage bucket exists.");
  return { id, path, mimeType: image.mimeType };
}

async function readGeneratedImage(image) {
  if (image.imagePath && supabase) {
    const { data, error } = await supabase.storage.from(IMAGE_BUCKET).download(image.imagePath);
    if (error || !data) throw new Error("The generated image is no longer available.");
    return { buffer: Buffer.from(await data.arrayBuffer()), mimeType: image.mimeType || data.type || "image/png" };
  }
  const oldUrl = new URL(image.imageUrl);
  if (!["media.pollinations.ai", "image.pollinations.ai"].includes(oldUrl.hostname)) throw new Error("The generated image is no longer available.");
  const response = await fetch(oldUrl);
  const mimeType = response.headers.get("content-type") || "";
  if (!response.ok || !mimeType.startsWith("image/")) throw new Error("The generated image is no longer available.");
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType };
}

async function readUsers() {
  if (supabase) {
    const { data, error } = await supabase.from("vast_state").select("users").eq("id", "main").maybeSingle();
    if (error) throw error;
    return Array.isArray(data?.users) ? data.users : [];
  }
  const rows = database.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
  return rows.map(row => ({
    id: row.id,
    username: row.username,
    salt: row.salt,
    passwordHash: row.password_hash,
    ...JSON.parse(row.profile_json || "{}"),
  }));
}

async function writeUsers(users) {
  if (supabase) {
    const { error } = await supabase.from("vast_state").upsert({
      id: "main",
      users,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    return;
  }
  const existingIds = new Set(database.prepare("SELECT id FROM users").all().map(row => row.id));
  const upsert = database.prepare(`
    INSERT INTO users (id, username, salt, password_hash, profile_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      salt = excluded.salt,
      password_hash = excluded.password_hash,
      profile_json = excluded.profile_json
  `);
  const remove = database.prepare("DELETE FROM users WHERE id = ?");
  database.exec("BEGIN");
  try {
    for (const user of users) {
      existingIds.delete(user.id);
      const { id, username, salt, passwordHash, ...profile } = user;
      upsert.run(id, username, salt, passwordHash, JSON.stringify(profile), profile.createdAt || Date.now());
    }
    for (const id of existingIds) remove.run(id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function importLegacyUsers() {
  const alreadyHasUsers = database.prepare("SELECT COUNT(*) AS total FROM users").get().total > 0;
  if (alreadyHasUsers) return;
  try {
    const legacyUsers = JSON.parse(await fs.readFile(usersFile, "utf8"));
    if (Array.isArray(legacyUsers) && legacyUsers.length) await writeUsers(legacyUsers);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await importLegacyUsers();

function migrateConversations(user) {
  if (Array.isArray(user.conversations)) return false;
  user.conversations = user.history?.length
    ? [{ id: crypto.randomUUID(), title: "Previous chat", messages: user.history, updatedAt: Date.now() }]
    : [];
  delete user.history;
  return true;
}

function migrateLibrary(user) {
  if (!Array.isArray(user.library)) user.library = [];
}

function migrateNotes(user) {
  if (!Array.isArray(user.notes)) user.notes = [];
}

function conversationSummary(conversation) {
  return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function getCookie(request, name) {
  const pairs = (request.headers.cookie || "").split(";").map(value => value.trim().split("="));
  return pairs.find(([key]) => key === name)?.[1];
}

function sessionSignature(payload) {
  const secret = process.env.SESSION_SECRET || process.env.GEMINI_API_KEY || "vast-local-development-secret";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function setSession(response, userId) {
  const payload = Buffer.from(JSON.stringify({ userId, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
  response.setHeader("Set-Cookie", `vast_session=${payload}.${sessionSignature(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function userIdFromRequest(request) {
  const token = getCookie(request, "vast_session");
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sessionSignature(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.expires > Date.now() && typeof session.userId === "string" ? session.userId : null;
  } catch (_) {
    return null;
  }
}

app.post("/api/auth/signup", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const isUsername = /^[a-zA-Z0-9_-]{3,30}$/.test(username);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) && username.length <= 100;
  if ((!isUsername && !isEmail) || password.length < 8) {
    return res.status(400).json({ error: "Enter a valid email or a 3–30 character username, plus a password of at least 8 characters." });
  }
  const users = await readUsers();
  if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "That username is already in use." });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const user = { id: crypto.randomUUID(), username, salt, passwordHash: passwordHash(password, salt), history: [], createdAt: Date.now() };
  users.push(user);
  await writeUsers(users);
  setSession(res, user.id);
  res.status(201).json({ username: user.username });
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = (await readUsers()).find(candidate => candidate.username.toLowerCase() === username.toLowerCase());
  if (!user || !crypto.timingSafeEqual(Buffer.from(user.passwordHash, "hex"), Buffer.from(passwordHash(password, user.salt), "hex"))) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  setSession(res, user.id);
  res.json({ username: user.username });
});

app.get("/api/auth/me", async (req, res) => {
  const user = (await readUsers()).find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Not signed in." });
  res.json({ username: user.username });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "vast_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.status(204).end();
});

app.post("/api/images", async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find(candidate => candidate.id === userIdFromRequest(req));
    if (!user) return res.status(401).json({ error: "Please sign in to generate an image." });
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_AI_TOKEN) return res.status(503).json({ error: "Image generation is not set up yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN in Render Environment Variables." });
    if (!supabase) return res.status(503).json({ error: "Image history needs Supabase to be connected before Cloudflare image generation can be used." });

    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Describe the image you want Vast to create." });
    if (prompt.length > 1_000) return res.status(400).json({ error: "Keep the image description under 1,000 characters." });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    user.imageGenerations = (user.imageGenerations || []).filter(time => Number(time) >= todayStart.getTime());
    if (user.imageGenerations.length >= DAILY_IMAGE_LIMIT) {
      return res.status(429).json({ error: "You have used today's 3 free image generations. Please come back tomorrow." });
    }

    const generated = await createCloudflareImage(prompt);
    const saved = await saveGeneratedImage(user.id, generated);

    const createdAt = Date.now();
    user.imageGenerations.push(createdAt);
    const image = {
      id: saved.id,
      prompt,
      imagePath: saved.path,
      mimeType: saved.mimeType,
      createdAt,
    };
    user.generatedImages = [image, ...(user.generatedImages || [])].slice(0, 30);
    await writeUsers(users);
    res.json({ imageId: image.id, imageUrl: imageUrlForClient(image), remaining: DAILY_IMAGE_LIMIT - user.imageGenerations.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Vast could not generate that image. Please try again." });
  }
});

app.post("/api/images/edit", async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find(candidate => candidate.id === userIdFromRequest(req));
    if (!user) return res.status(401).json({ error: "Please sign in to edit an image." });
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_AI_TOKEN) return res.status(503).json({ error: "Image generation is not set up yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN in Render Environment Variables." });
    if (!supabase) return res.status(503).json({ error: "Image history needs Supabase to be connected before Cloudflare image generation can be used." });
    const imageId = String(req.body.imageId || "");
    const prompt = String(req.body.prompt || "").trim();
    const sourceImage = (user.generatedImages || []).find(image => image.id === imageId);
    if (!sourceImage) return res.status(400).json({ error: "Choose an image created by Vast to edit." });
    if (!prompt) return res.status(400).json({ error: "Describe how you want to edit the image." });
    if (prompt.length > 1_000) return res.status(400).json({ error: "Keep the edit instruction under 1,000 characters." });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    user.imageGenerations = (user.imageGenerations || []).filter(time => Number(time) >= todayStart.getTime());
    if (user.imageGenerations.length >= DAILY_IMAGE_LIMIT) {
      return res.status(429).json({ error: "You have used today's 3 free image generations. Please come back tomorrow." });
    }

    const source = await readGeneratedImage(sourceImage);
    const generated = await createCloudflareImage(prompt, source);
    const saved = await saveGeneratedImage(user.id, generated);

    const createdAt = Date.now();
    user.imageGenerations.push(createdAt);
    const image = {
      id: saved.id,
      prompt: `Edit: ${prompt}`,
      imagePath: saved.path,
      mimeType: saved.mimeType,
      createdAt,
    };
    user.generatedImages = [image, ...(user.generatedImages || [])].slice(0, 30);
    await writeUsers(users);
    res.json({ imageId: image.id, imageUrl: imageUrlForClient(image), remaining: DAILY_IMAGE_LIMIT - user.imageGenerations.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Vast could not edit that image. Please try again." });
  }
});

app.get("/api/images", async (req, res) => {
  const user = (await readUsers()).find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  res.json({ images: (user.generatedImages || []).slice(0, 30).map(image => ({ ...image, imageUrl: imageUrlForClient(image) })) });
});

app.get("/api/images/file/:imageId", async (req, res) => {
  try {
    const user = (await readUsers()).find(candidate => candidate.id === userIdFromRequest(req));
    const image = user && (user.generatedImages || []).find(item => item.id === req.params.imageId);
    if (!image) return res.status(404).end();
    const source = await readGeneratedImage(image);
    res.setHeader("Content-Type", source.mimeType);
    res.send(source.buffer);
  } catch (_) {
    res.status(404).end();
  }
});

app.get("/api/images/download", async (req, res) => {
  try {
    const user = (await readUsers()).find(candidate => candidate.id === userIdFromRequest(req));
    const image = user && (user.generatedImages || []).find(item => item.id === String(req.query.id || ""));
    if (!image) return res.status(404).json({ error: "That image is no longer available." });
    const source = await readGeneratedImage(image);
    res.setHeader("Content-Type", source.mimeType);
    res.setHeader("Content-Disposition", 'attachment; filename="vast-image.png"');
    res.send(source.buffer);
  } catch (_) {
    res.status(400).json({ error: "That image cannot be downloaded through Vast." });
  }
});

app.get("/api/conversations", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  const migrated = migrateConversations(user);
  if (migrated) await writeUsers(users);
  res.json({ conversations: user.conversations.sort((a, b) => b.updatedAt - a.updatedAt).map(conversationSummary) });
});

app.get("/api/library", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  migrateLibrary(user);
  res.json({ files: user.library.sort((a, b) => b.addedAt - a.addedAt) });
});

app.post("/api/library", upload.single("file"), async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  if (!req.file) return res.status(400).json({ error: "Choose a file to add to your library." });
  migrateLibrary(user);
  const id = crypto.randomUUID();
  const extension = path.extname(req.file.originalname).replace(/[^.a-zA-Z0-9]/g, "");
  const userDirectory = path.join(libraryDirectory, user.id);
  await fs.mkdir(userDirectory, { recursive: true });
  await fs.writeFile(path.join(userDirectory, `${id}${extension}`), req.file.buffer);
  const file = { id, name: req.file.originalname, type: req.file.mimetype || "file", size: req.file.size, addedAt: Date.now() };
  user.library.push(file);
  await writeUsers(users);
  res.status(201).json({ file });
});

app.get("/api/notes", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  migrateNotes(user);
  res.json({ notes: user.notes.sort((a, b) => b.updatedAt - a.updatedAt) });
});

app.post("/api/notes", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  migrateNotes(user);
  const note = { id: crypto.randomUUID(), title: "Untitled note", body: "", updatedAt: Date.now() };
  user.notes.unshift(note);
  await writeUsers(users);
  res.status(201).json({ note });
});

app.put("/api/notes/:noteId", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  migrateNotes(user);
  const note = user.notes.find(item => item.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: "Note not found." });
  note.title = String(req.body.title || "Untitled note").trim().slice(0, 120) || "Untitled note";
  note.body = String(req.body.body || "").slice(0, 50000);
  note.updatedAt = Date.now();
  await writeUsers(users);
  res.json({ note });
});

app.post("/api/conversations", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  migrateConversations(user);
  const newConversation = { id: crypto.randomUUID(), title: "New conversation", messages: [], updatedAt: Date.now() };
  user.conversations.unshift(newConversation);
  await writeUsers(users);
  res.status(201).json({ conversation: conversationSummary(newConversation) });
});

app.get("/api/conversations/:conversationId", async (req, res) => {
  const users = await readUsers();
  const user = users.find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  migrateConversations(user);
  const conversation = user.conversations.find(item => item.id === req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  res.json({ conversation });
});

// Makes your index.html, style.css, and app.js available in the browser.
app.use(express.static("."));

// This receives messages from your chatbot webpage.
async function readAttachment(file) {
  const name = file.originalname.toLowerCase();

  if (file.mimetype === "application/pdf" || name.endsWith(".pdf")) {
    const parser = new PDFParse({ data: file.buffer });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }

  if (file.mimetype.includes("wordprocessingml") || name.endsWith(".docx")) {
    return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  }

  if (file.mimetype.startsWith("text/") || /\.(txt|md|csv|json)$/.test(name)) {
    return file.buffer.toString("utf8");
  }

  throw new Error("Supported attachments are images, PDF, DOCX, TXT, MD, CSV, and JSON files.");
}

app.post("/api/chat", upload.single("file"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "Vast is not connected to Gemini yet. Add GEMINI_API_KEY in Render Environment Variables." });
    }
    const users = await readUsers();
    const user = users.find(candidate => candidate.id === userIdFromRequest(req));
    if (!user) return res.status(401).json({ error: "Please sign in to chat with Vast." });
    migrateConversations(user);
    let activeConversation = user.conversations.find(item => item.id === req.body.conversationId);
    if (!activeConversation) {
      activeConversation = { id: crypto.randomUUID(), title: "New conversation", messages: [], updatedAt: Date.now() };
      user.conversations.unshift(activeConversation);
    }
    const userMessage = req.body.message || "Please summarize this attachment.";
    let preferences = { name: "Vast", style: "clear and concise" };
    try {
      const submittedPreferences = JSON.parse(req.body.preferences || "{}");
      preferences.name = String(submittedPreferences.name || preferences.name).slice(0, 30);
      preferences.style = String(submittedPreferences.style || preferences.style).slice(0, 80);
    } catch (_) { /* Keep safe defaults for malformed browser input. */ }
    const attachment = req.file;
    const systemInstruction = `You are ${preferences.name}, a friendly and helpful AI assistant. You are speaking with ${user.username}. Reply in a ${preferences.style} style. Format answers in clean Markdown: use short headings and bullet or numbered lists when useful; keep paragraphs short. Never use decorative separator lines, repeated symbols, or overly poetic language unless the user asks for it. For simple factual questions, give a concise direct answer first. Answer questions using the supplied attachment when one is provided.`;
    // Keep recent context without re-sending a long conversation on every request.
    const memory = activeConversation.messages.slice(-8);
    const contents = memory.map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content || "") }],
    }));

    if (attachment?.mimetype.startsWith("image/")) {
      const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
      if (!supportedImageTypes.has(attachment.mimetype)) {
        throw new Error("Vast can analyze JPG, PNG, and WebP images. Please convert this photo to JPG or PNG, then try again.");
      }
      if (attachment.size > 10 * 1024 * 1024) {
        throw new Error("This image is too large. Please choose an image smaller than 10 MB.");
      }
      contents.push({
        role: "user",
        parts: [
          { text: userMessage },
          { inlineData: { mimeType: attachment.mimetype, data: attachment.buffer.toString("base64") } },
        ],
      });
    } else if (attachment) {
      const fileText = await readAttachment(attachment);
      contents.push({ role: "user", parts: [{ text: `Attached file: ${attachment.originalname}\n\n${fileText.slice(0, 100000)}\n\nUser question: ${userMessage}` }] });
    } else {
      contents.push({ role: "user", parts: [{ text: userMessage }] });
    }

    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const completion = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });
    const completionData = await completion.json().catch(() => ({}));
    if (!completion.ok) {
      console.error("Gemini request failed", completion.status, completionData);
      throw new Error(completionData.error?.message || "Gemini could not answer right now. Please try again.");
    }

    const aiReply = completionData.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    activeConversation.messages.push({ role: "user", content: userMessage }, { role: "assistant", content: aiReply || "" });
    activeConversation.messages = activeConversation.messages.slice(-40);
    if (activeConversation.title === "New conversation") {
      activeConversation.title = userMessage.replace(/\s+/g, " ").slice(0, 42) || "New conversation";
    }
    activeConversation.updatedAt = Date.now();
    await writeUsers(users);

    res.json({
      reply: aiReply || "Sorry, I could not create a response.",
      conversationId: activeConversation.id,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message || "Could not process that attachment. Please try again.",
    });
  }
});

// Starts your chatbot website at http://localhost:3000
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Vast is running at: http://localhost:${port}`);
});
