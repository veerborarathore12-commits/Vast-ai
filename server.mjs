import express from "express";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import multer from "multer";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DatabaseSync } from "node:sqlite";

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
const sessions = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});
const DAILY_IMAGE_LIMIT = 3;

app.use(express.json());

async function readUsers() {
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

function setSession(response, userId) {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { userId, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  response.setHeader("Set-Cookie", `nova_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function userIdFromRequest(request) {
  const session = sessions.get(getCookie(request, "nova_session"));
  if (!session || session.expires < Date.now()) return null;
  return session.userId;
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
  sessions.delete(getCookie(req, "nova_session"));
  res.setHeader("Set-Cookie", "nova_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.status(204).end();
});

app.post("/api/images", async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find(candidate => candidate.id === userIdFromRequest(req));
    if (!user) return res.status(401).json({ error: "Please sign in to generate an image." });
    if (!process.env.POLLINATIONS_API_KEY) {
      return res.status(503).json({ error: "Image generation is not set up yet. Add POLLINATIONS_API_KEY in Render Environment Variables." });
    }

    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Describe the image you want Vast to create." });
    if (prompt.length > 1_000) return res.status(400).json({ error: "Keep the image description under 1,000 characters." });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    user.imageGenerations = (user.imageGenerations || []).filter(time => Number(time) >= todayStart.getTime());
    if (user.imageGenerations.length >= DAILY_IMAGE_LIMIT) {
      return res.status(429).json({ error: "You have used today's 3 free image generations. Please come back tomorrow." });
    }

    const response = await fetch("https://gen.pollinations.ai/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        model: "black-forest-labs/flux.1-schnell",
        size: "1024x1024",
        response_format: "url",
        safe: true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.data?.[0]?.url) {
      console.error("Pollinations image request failed", response.status, data);
      return res.status(502).json({ error: "Image generation is temporarily unavailable. Please try again in a moment." });
    }

    const createdAt = Date.now();
    user.imageGenerations.push(createdAt);
    user.generatedImages = [{
      id: crypto.randomUUID(),
      prompt,
      imageUrl: data.data[0].url,
      createdAt,
    }, ...(user.generatedImages || [])].slice(0, 30);
    await writeUsers(users);
    res.json({ imageUrl: data.data[0].url, remaining: DAILY_IMAGE_LIMIT - user.imageGenerations.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Vast could not generate that image. Please try again." });
  }
});

app.get("/api/images", async (req, res) => {
  const user = (await readUsers()).find(candidate => candidate.id === userIdFromRequest(req));
  if (!user) return res.status(401).json({ error: "Please sign in." });
  res.json({ images: (user.generatedImages || []).slice(0, 30) });
});

app.get("/api/images/download", async (req, res) => {
  try {
    if (!userIdFromRequest(req)) return res.status(401).json({ error: "Please sign in." });
    const imageUrl = new URL(String(req.query.url || ""));
    if (!["media.pollinations.ai", "image.pollinations.ai"].includes(imageUrl.hostname)) {
      return res.status(400).json({ error: "That image cannot be downloaded through Vast." });
    }
    const imageResponse = await fetch(imageUrl);
    const contentType = imageResponse.headers.get("content-type") || "";
    if (!imageResponse.ok || !contentType.startsWith("image/")) {
      return res.status(502).json({ error: "The generated image is no longer available." });
    }
    const image = Buffer.from(await imageResponse.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", 'attachment; filename="vast-image.png"');
    res.send(image);
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
    let model = "openai/gpt-oss-20b";
    let messages;

    const systemMessage = {
      role: "system",
      content: `You are ${preferences.name}, a friendly and helpful AI assistant. You are speaking with ${user.username}. Reply in a ${preferences.style} style. Format answers in clean Markdown: use short headings and bullet or numbered lists when useful; keep paragraphs short. Never use decorative separator lines, repeated symbols, or overly poetic language unless the user asks for it. For simple factual questions, give a concise direct answer first. Answer questions using the supplied attachment when one is provided.`,
    };
    const memory = activeConversation.messages.slice(-12);

    if (attachment?.mimetype.startsWith("image/")) {
      const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
      if (!supportedImageTypes.has(attachment.mimetype)) {
        throw new Error("Vast can analyze JPG, PNG, and WebP images. Please convert this photo to JPG or PNG, then try again.");
      }
      // Image data is base64 encoded before being sent to Groq, so leave room below
      // Groq's request-size limit for the encoded payload.
      if (attachment.size > 10 * 1024 * 1024) {
        throw new Error("This image is too large. Please choose an image smaller than 10 MB.");
      }
      model = "qwen/qwen3.8-27b";
      messages = [
        systemMessage, ...memory,
        {
          role: "user",
          content: [
            { type: "text", text: userMessage },
            {
              type: "image_url",
              image_url: {
                url: `data:${attachment.mimetype};base64,${attachment.buffer.toString("base64")}`,
              },
            },
          ],
        },
      ];
    } else if (attachment) {
      const fileText = await readAttachment(attachment);
      messages = [
        systemMessage, ...memory,
        {
          role: "user",
          content: `Attached file: ${attachment.originalname}\n\n${fileText.slice(0, 100000)}\n\nUser question: ${userMessage}`,
        },
      ];
    } else {
      messages = [systemMessage, ...memory, { role: "user", content: userMessage }];
    }

    const completion = await groq.chat.completions.create({
      model,
      messages,
    });

    const aiReply = completion.choices[0]?.message?.content;
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
