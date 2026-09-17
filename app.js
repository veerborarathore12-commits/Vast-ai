lucide.createIcons();

const form = document.querySelector('#composer');
const prompt = document.querySelector('#prompt');
const conversation = document.querySelector('#conversation');
const welcome = document.querySelector('#welcome');
const mic = document.querySelector('#mic');
const history = document.querySelector('#history');
const historyPanel = document.querySelector('.history-panel');
const historyToggle = document.querySelector('#historyToggle');
const fileInput = document.querySelector('#fileInput');
const fileStatus = document.querySelector('#fileStatus');
const imageModeButton = document.querySelector('#imageMode');
const authScreen = document.querySelector('#authScreen');
const authForm = document.querySelector('#authForm');
const authTitle = document.querySelector('#authTitle');
const authCopy = document.querySelector('#authCopy');
const authToggle = document.querySelector('#authToggle');
const authError = document.querySelector('#authError');
const authUsername = document.querySelector('#authUsername');
const authPassword = document.querySelector('#authPassword');
const togglePassword = document.querySelector('#togglePassword');
const logout = document.querySelector('#logout');
const newChat = document.querySelector('#newChat');
const chatNav = document.querySelector('#chatNav');
const libraryNav = document.querySelector('#libraryNav');
const chatView = document.querySelector('#chatView');
const libraryView = document.querySelector('#libraryView');
const libraryGrid = document.querySelector('#libraryGrid');
const imageHistoryGrid = document.querySelector('#imageHistoryGrid');
const libraryFileInput = document.querySelector('#libraryFileInput');
const notesNav = document.querySelector('#notesNav');
const exploreNav = document.querySelector('#exploreNav');
const exploreView = document.querySelector('#exploreView');
const overviewTab = document.querySelector('#overviewTab');
const chatTab = document.querySelector('#chatTab');
const projectsTab = document.querySelector('#projectsTab');
const settingsNav = document.querySelector('#settingsNav');
const overviewView = document.querySelector('#overviewView');
const projectsView = document.querySelector('#projectsView');
const settingsView = document.querySelector('#settingsView');
const projectsGrid = document.querySelector('#projectsGrid');
const newProject = document.querySelector('#newProject');
const assistantName = document.querySelector('#assistantName');
const assistantLabel = document.querySelector('#assistantLabel');
const responseStyle = document.querySelector('#responseStyle');
const voicePreference = document.querySelector('#voicePreference');
const saveSettings = document.querySelector('#saveSettings');
const settingsStatus = document.querySelector('#settingsStatus');
const themeChoices = document.querySelector('#themeChoices');
const notesView = document.querySelector('#notesView');
const notesList = document.querySelector('#notesList');
const newNote = document.querySelector('#newNote');
const noteTitle = document.querySelector('#noteTitle');
const noteBody = document.querySelector('#noteBody');
const saveNote = document.querySelector('#saveNote');
const noteStatus = document.querySelector('#noteStatus');
let voiceInputPending = false;
let selectedFile = null;
let creatingAccount = false;
let imageMode = false;

historyToggle.addEventListener('click', () => {
  const isOpen = historyPanel.classList.toggle('mobile-open');
  historyToggle.setAttribute('aria-label', isOpen ? 'Close chat history' : 'Open chat history');
});
let activeConversationId = null;
let activeNoteId = null;

function getPreferences() {
  return { name: 'Vast', style: 'clear and concise', voice: true, theme: 'lime', ...JSON.parse(localStorage.getItem('vast-preferences') || '{}') };
}

function applyPreferences() {
  const preferences = getPreferences();
  assistantLabel.textContent = `${preferences.name} AI`;
  prompt.placeholder = `Message ${preferences.name}...`;
  document.title = `${preferences.name} — AI Chat`;
  document.body.dataset.theme = preferences.theme === 'lime' ? '' : preferences.theme;
  document.querySelectorAll('.theme-choice').forEach(choice => choice.classList.toggle('active', choice.dataset.theme === preferences.theme));
  return preferences;
}

function allViewsOff() { [chatView, libraryView, notesView, exploreView, overviewView, projectsView, settingsView].forEach(view => view.classList.add('hidden')); }
function allNavOff() { [chatNav, libraryNav, notesNav, exploreNav, settingsNav].forEach(item => item.classList.remove('active')); [overviewTab, chatTab, projectsTab].forEach(item => item.classList.remove('selected')); }
function showOverview() { allViewsOff(); allNavOff(); overviewView.classList.remove('hidden'); overviewTab.classList.add('selected'); refreshOverview(); }
function showProjects() { allViewsOff(); allNavOff(); projectsView.classList.remove('hidden'); projectsTab.classList.add('selected'); renderProjects(); }
function showSettings() { allViewsOff(); allNavOff(); settingsView.classList.remove('hidden'); settingsNav.classList.add('active'); const prefs = getPreferences(); assistantName.value = prefs.name; responseStyle.value = prefs.style; voicePreference.checked = prefs.voice; document.querySelectorAll('.theme-choice').forEach(choice => choice.classList.toggle('active', choice.dataset.theme === prefs.theme)); }

async function refreshOverview() {
  const [chats, notes, files] = await Promise.all([fetch('/api/conversations'), fetch('/api/notes'), fetch('/api/library')]);
  if (chats.ok) document.querySelector('#overviewChatCount').textContent = (await chats.json()).conversations.length;
  if (notes.ok) document.querySelector('#overviewNoteCount').textContent = (await notes.json()).notes.length;
  if (files.ok) document.querySelector('#overviewFileCount').textContent = (await files.json()).files.length;
}
function renderProjects() { const projects = JSON.parse(localStorage.getItem('nova-projects') || '[]'); projectsGrid.innerHTML = projects.length ? '' : '<div class="empty-library">No projects yet. Create one to organize your work.</div>'; projects.forEach(project => { const item = document.createElement('article'); item.className = 'project-card'; item.innerHTML = `<h3></h3><p></p>`; item.querySelector('h3').textContent = project.name; item.querySelector('p').textContent = project.description || 'No description yet'; projectsGrid.append(item); }); }

overviewTab.addEventListener('click', showOverview); chatTab.addEventListener('click', showChat); projectsTab.addEventListener('click', showProjects); settingsNav.addEventListener('click', showSettings);
document.querySelector('#overviewNewChat').addEventListener('click', async () => { showChat(); await startNewChat(); });
document.querySelector('#overviewOpenNotes').addEventListener('click', showNotes);
newProject.addEventListener('click', () => { const name = window.prompt('Project name'); if (!name?.trim()) return; const description = window.prompt('Short description (optional)') || ''; const projects = JSON.parse(localStorage.getItem('nova-projects') || '[]'); projects.push({ name: name.trim(), description }); localStorage.setItem('nova-projects', JSON.stringify(projects)); renderProjects(); });
saveSettings.addEventListener('click', () => {
  const preferences = { ...getPreferences(), name: assistantName.value.trim().slice(0, 30) || 'Vast', style: responseStyle.value, voice: voicePreference.checked };
  localStorage.setItem('vast-preferences', JSON.stringify(preferences));
  applyPreferences();
  settingsStatus.textContent = 'Preferences saved and active.';
});

themeChoices.addEventListener('click', event => {
  const choice = event.target.closest('.theme-choice');
  if (!choice) return;
  const preferences = { ...getPreferences(), theme: choice.dataset.theme };
  localStorage.setItem('vast-preferences', JSON.stringify(preferences));
  applyPreferences();
  settingsStatus.textContent = `${choice.querySelector('span').textContent} theme applied.`;
});

function renderNotes(notes) {
  notesList.innerHTML = '';
  if (!notes.length) notesList.innerHTML = '<p class="history-day">No notes yet</p>';
  notes.forEach(note => {
    const button = document.createElement('button');
    button.className = `note-list-item ${note.id === activeNoteId ? 'current' : ''}`;
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = note.title;
    button.querySelector('span').textContent = note.body || 'Empty note';
    button.addEventListener('click', () => openNote(note));
    notesList.append(button);
  });
}

async function loadNotes() {
  const response = await fetch('/api/notes');
  if (!response.ok) return;
  renderNotes((await response.json()).notes);
}

function openNote(note) {
  activeNoteId = note.id;
  noteTitle.value = note.title;
  noteBody.value = note.body;
  noteStatus.textContent = 'Saved';
  loadNotes();
}

async function createNote() {
  const response = await fetch('/api/notes', { method: 'POST' });
  if (!response.ok) return;
  openNote((await response.json()).note);
  noteTitle.focus();
}

async function persistNote() {
  if (!activeNoteId) return createNote();
  noteStatus.textContent = 'Saving…';
  const response = await fetch(`/api/notes/${activeNoteId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: noteTitle.value, body: noteBody.value }),
  });
  if (!response.ok) { noteStatus.textContent = 'Could not save'; return; }
  const data = await response.json();
  noteStatus.textContent = 'Saved';
  activeNoteId = data.note.id;
  await loadNotes();
}

function showNotes() {
  chatView.classList.add('hidden'); libraryView.classList.add('hidden'); exploreView.classList.add('hidden'); overviewView.classList.add('hidden'); projectsView.classList.add('hidden'); settingsView.classList.add('hidden'); notesView.classList.remove('hidden');
  chatNav.classList.remove('active'); libraryNav.classList.remove('active'); exploreNav.classList.remove('active'); notesNav.classList.add('active');
  loadNotes();
}

notesNav.addEventListener('click', showNotes);
newNote.addEventListener('click', createNote);
saveNote.addEventListener('click', persistNote);

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderLibrary(files) {
  if (!files.length) {
    libraryGrid.innerHTML = '<div class="empty-library">Your library is empty. Upload a document, image, or other reference file to keep it here.</div>';
    return;
  }
  libraryGrid.innerHTML = '';
  files.forEach(file => {
    const card = document.createElement('article');
    card.className = 'library-card';
    card.innerHTML = '<i data-lucide="file-text"></i><h3></h3><p></p>';
    card.querySelector('h3').textContent = file.name;
    card.querySelector('p').textContent = `${formatFileSize(file.size)} · ${new Date(file.addedAt).toLocaleDateString()}`;
    libraryGrid.append(card);
  });
  lucide.createIcons();
}

async function loadLibrary() {
  const response = await fetch('/api/library');
  if (!response.ok) return;
  renderLibrary((await response.json()).files);
  loadImageHistory();
}

async function loadImageHistory() {
  const response = await fetch('/api/images');
  if (!response.ok) return;
  renderImageHistory((await response.json()).images);
}

function downloadUrl(imageUrl) {
  return `/api/images/download?url=${encodeURIComponent(imageUrl)}`;
}

function renderImageHistory(images) {
  imageHistoryGrid.innerHTML = '';
  if (!images.length) {
    imageHistoryGrid.innerHTML = '<p class="image-history-empty">Your generated images will appear here.</p>';
    return;
  }
  images.forEach(item => {
    const card = document.createElement('article');
    card.className = 'image-history-card';
    const image = document.createElement('img');
    image.src = item.imageUrl;
    image.alt = item.prompt;
    const promptText = document.createElement('p');
    promptText.textContent = item.prompt;
    const download = document.createElement('a');
    download.className = 'image-download';
    download.href = downloadUrl(item.imageUrl);
    download.textContent = 'Download';
    card.append(image, promptText, download);
    imageHistoryGrid.append(card);
  });
}

function showLibrary() {
  chatView.classList.add('hidden'); notesView.classList.add('hidden'); exploreView.classList.add('hidden'); overviewView.classList.add('hidden'); projectsView.classList.add('hidden'); settingsView.classList.add('hidden');
  libraryView.classList.remove('hidden');
  chatNav.classList.remove('active');
  libraryNav.classList.add('active');
  exploreNav.classList.remove('active');
  loadLibrary();
}

function showChat() {
  libraryView.classList.add('hidden'); notesView.classList.add('hidden'); exploreView.classList.add('hidden'); overviewView.classList.add('hidden'); projectsView.classList.add('hidden'); settingsView.classList.add('hidden');
  chatView.classList.remove('hidden');
  libraryNav.classList.remove('active');
  notesNav.classList.remove('active');
  exploreNav.classList.remove('active');
  overviewTab.classList.remove('selected'); projectsTab.classList.remove('selected'); chatTab.classList.add('selected');
  chatNav.classList.add('active');
}

chatNav.addEventListener('click', showChat);
libraryNav.addEventListener('click', showLibrary);

function showExplore() {
  chatView.classList.add('hidden'); libraryView.classList.add('hidden'); notesView.classList.add('hidden'); overviewView.classList.add('hidden'); projectsView.classList.add('hidden'); settingsView.classList.add('hidden'); exploreView.classList.remove('hidden');
  chatNav.classList.remove('active'); libraryNav.classList.remove('active'); notesNav.classList.remove('active'); exploreNav.classList.add('active');
}

exploreNav.addEventListener('click', showExplore);
document.querySelectorAll('[data-explore]').forEach(card => card.addEventListener('click', async () => {
  showChat();
  if (!activeConversationId) await startNewChat();
  prompt.value = card.dataset.explore;
  prompt.focus();
  prompt.dispatchEvent(new Event('input'));
}));

libraryFileInput.addEventListener('change', async () => {
  const file = libraryFileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch('/api/library', { method: 'POST', body: formData });
  libraryFileInput.value = '';
  if (!response.ok) {
    const data = await response.json();
    alert(data.error || 'Unable to upload the file.');
    return;
  }
  await loadLibrary();
});

function renderHistory(items) {
  history.innerHTML = '<p class="history-day">YOUR CHATS</p>';
  if (!items.length) {
    history.innerHTML += '<p class="history-day">No saved chats yet</p>';
    return;
  }
  items.forEach(item => {
    const button = document.createElement('button');
    button.className = `history-item ${item.id === activeConversationId ? 'current' : ''}`;
    button.innerHTML = '<i data-lucide="message-circle"></i><span></span><i class="dots" data-lucide="more-horizontal"></i>';
    button.querySelector('span').textContent = item.title;
    button.addEventListener('click', () => loadConversation(item.id));
    history.append(button);
  });
  lucide.createIcons();
}

async function loadConversations() {
  const response = await fetch('/api/conversations');
  if (!response.ok) return;
  const data = await response.json();
  renderHistory(data.conversations);
}

async function loadConversation(id) {
  const response = await fetch(`/api/conversations/${id}`);
  if (!response.ok) return;
  const data = await response.json();
  activeConversationId = data.conversation.id;
  historyPanel.classList.remove('mobile-open');
  conversation.innerHTML = '';
  data.conversation.messages.forEach(message => addMessage(message.content, message.role === 'assistant' ? 'ai' : 'user'));
  await loadConversations();
}

async function startNewChat() {
  const response = await fetch('/api/conversations', { method: 'POST' });
  if (!response.ok) return;
  const data = await response.json();
  activeConversationId = data.conversation.id;
  conversation.innerHTML = '';
  await loadConversations();
  prompt.focus();
}

togglePassword.addEventListener('click', () => {
  const isHidden = authPassword.type === 'password';
  authPassword.type = isHidden ? 'text' : 'password';
  togglePassword.textContent = isHidden ? 'Hide' : 'Show';
  togglePassword.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
});

function showAuthenticatedUser(username) {
  authScreen.classList.add('hidden');
  logout.textContent = username.slice(0, 1).toUpperCase();
  logout.title = `Signed in as ${username}. Click to sign out.`;
}

async function checkSession() {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) return;
    const data = await response.json();
    showAuthenticatedUser(data.username);
    await loadConversations();
  } catch (_) { /* The sign-in screen remains visible. */ }
}

authToggle.addEventListener('click', () => {
  creatingAccount = !creatingAccount;
  authTitle.textContent = creatingAccount ? 'Create your account' : 'Sign in to continue';
  authCopy.textContent = creatingAccount ? 'Your private chat memory begins here.' : 'Your chats and preferences stay with your account.';
  authToggle.textContent = creatingAccount ? 'Already have an account? Sign in' : 'New here? Create an account';
  authForm.querySelector('.auth-submit').textContent = creatingAccount ? 'Create account' : 'Sign in';
  authError.textContent = '';
});

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  authError.textContent = '';
  const response = await fetch(creatingAccount ? '/api/auth/signup' : '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: authUsername.value, password: authPassword.value }),
  });
  const data = await response.json();
  if (!response.ok) {
    authError.textContent = data.error || 'Unable to sign in.';
    return;
  }
  authPassword.value = '';
  showAuthenticatedUser(data.username);
  await startNewChat();
});

logout.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

newChat.addEventListener('click', startNewChat);

checkSession();
applyPreferences();

fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files[0] || null;
  fileStatus.textContent = selectedFile ? selectedFile.name : '';
});

imageModeButton.addEventListener('click', () => {
  imageMode = !imageMode;
  imageModeButton.classList.toggle('active', imageMode);
  imageModeButton.setAttribute('aria-pressed', String(imageMode));
  prompt.placeholder = imageMode ? 'Describe an image to create…' : `Message ${getPreferences().name}...`;
  if (imageMode) fileInput.value = '';
  if (imageMode) { selectedFile = null; fileStatus.textContent = ''; }
});

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = "en-US";
  speech.rate = 1;
  speech.pitch = 1;

  window.speechSynthesis.speak(speech);
}

async function replyTo(text, shouldSpeak = false) {
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.textContent = `${getPreferences().name} is thinking…`;
  conversation.append(typing);

  try {
    const formData = new FormData();
    formData.append("message", text);
    formData.append("preferences", JSON.stringify(getPreferences()));
    if (activeConversationId) formData.append("conversationId", activeConversationId);
    if (selectedFile) formData.append("file", selectedFile);

    const response = await fetch("/api/chat", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    typing.remove();

    if (!response.ok) {
      throw new Error(data.error);
    }

    addMessage(data.reply, "ai");
    activeConversationId = data.conversationId;
    await loadConversations();
    if (shouldSpeak && getPreferences().voice) speak(data.reply);
  } catch (error) {
    typing.remove();

    addMessage(
      error.message || "I could not connect to Groq. Please check the server and API key, then try again.",
      "ai"
    );

    console.error(error);
  }
}

async function generateImage(text) {
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.textContent = 'Vast is creating your image…';
  conversation.append(typing);
  try {
    const response = await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
    });
    const data = await response.json();
    typing.remove();
    if (!response.ok) throw new Error(data.error);
    addGeneratedImage(data.imageUrl, data.remaining);
  } catch (error) {
    typing.remove();
    addMessage(error.message || 'Vast could not generate that image.', 'ai');
  }
}

function addGeneratedImage(imageUrl, remaining) {
  if (welcome) welcome.remove();
  const result = document.createElement('div');
  result.className = 'image-result';
  const label = document.createElement('p');
  label.textContent = `Generated by Vast · ${remaining} free image${remaining === 1 ? '' : 's'} left today`;
  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = 'AI-generated image';
  const download = document.createElement('a');
  download.href = downloadUrl(imageUrl);
  download.textContent = 'Download image';
  result.append(label, image, download);
  conversation.append(result);
  conversation.scrollTop = conversation.scrollHeight;
}
function addMessage(text, role) {
  if (welcome) welcome.remove();
  const message = document.createElement('div');
  message.className = `message ${role}`;
  if (role === 'ai') {
    message.innerHTML = `${renderMarkdown(text)}<button class="message-speak" type="button" aria-label="Read this response aloud" title="Read aloud"><i data-lucide="volume-2"></i> Listen</button>`;
    message.querySelector('.message-speak').addEventListener('click', () => speak(text));
  } else message.textContent = text;
  conversation.append(message);
  if (role === 'ai') lucide.createIcons();
  conversation.scrollTop = conversation.scrollHeight;
}

function escapeHtml(text) {
  return text.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const output = [];
  let listItems = [];
  const flushList = () => {
    if (listItems.length) {
      output.push(`<ul>${listItems.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
      listItems = [];
    }
  };
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const heading = line.match(/^\s*#{1,3}\s+(.+)$/);
    if (bullet || numbered) { listItems.push((bullet || numbered)[1]); continue; }
    flushList();
    if (!line.trim()) continue;
    if (/^\s*[-*_]{3,}\s*$/.test(line)) { output.push('<hr>'); continue; }
    if (heading) { output.push(`<h3>${inlineMarkdown(heading[1])}</h3>`); continue; }
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  flushList();
  return output.join('') || '<p>No response received.</p>';
}

function submitMessage(value = prompt.value) {
  const text = value.trim() || (selectedFile ? `Please summarize ${selectedFile.name}.` : '');
  if (!text) return;
  const shouldSpeak = voiceInputPending;
  voiceInputPending = false;
  addMessage(imageMode ? `Create an image: ${text}` : text, 'user'); prompt.value = ''; prompt.style.height = 'auto';
  if (imageMode) generateImage(text); else replyTo(text, shouldSpeak);
  selectedFile = null;
  fileInput.value = '';
  fileStatus.textContent = '';
  const item = document.createElement('button');
  item.className = 'history-item'; item.innerHTML = '<i data-lucide="message-circle"></i><span></span><i class="dots" data-lucide="more-horizontal"></i>';
  item.querySelector('span').textContent = text; history.insertBefore(item, history.querySelector('.history-day:nth-of-type(2)') || null); lucide.createIcons();
}
form.addEventListener('submit', e => { e.preventDefault(); submitMessage(); });
prompt.addEventListener('input', () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 130)}px`; });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => submitMessage(button.dataset.prompt)));

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition(); recognition.continuous = false; recognition.interimResults = true; recognition.lang = 'en-US';
  recognition.onstart = () => { voiceInputPending = true; mic.classList.add('recording'); prompt.placeholder = 'Listening…'; };
  recognition.onresult = e => { prompt.value = [...e.results].map(r => r[0].transcript).join(''); prompt.dispatchEvent(new Event('input')); };
  recognition.onend = () => {
    mic.classList.remove('recording');
    prompt.placeholder = `Message ${getPreferences().name}...`;
    if (voiceInputPending && prompt.value.trim()) submitMessage();
  };
  mic.addEventListener('click', () => recognition.start());
} else { mic.title = 'Voice input is not supported in this browser'; mic.style.opacity = '.4'; }
