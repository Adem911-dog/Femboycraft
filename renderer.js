const $ = (selector) => document.querySelector(selector);
const state = { activeType: "mod", account: null, skinDataUrl: "", versions: new Map(), installedPvpVersions: new Set(), pvpPackInstalling: false };
let toastTimer;
let logoClicks = 0;
let logoClickTimer;
let konamiIndex = 0;
const konamiSequence = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

function toast(message, kind = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3600);
}

function openInputDialog({ title, description, label, placeholder, initialValue = "", maxLength, validate }) {
  const backdrop = $("#dialog-backdrop");
  const form = $("#input-dialog");
  const input = $("#dialog-input");
  const error = $("#dialog-error");
  const previousFocus = document.activeElement;

  $("#dialog-title").textContent = title;
  $("#dialog-description").textContent = description;
  $("#dialog-label").textContent = label;
  input.placeholder = placeholder;
  input.value = initialValue;
  input.maxLength = maxLength;
  error.textContent = "";
  backdrop.hidden = false;
  requestAnimationFrame(() => input.focus());

  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      backdrop.hidden = true;
      form.removeEventListener("submit", onSubmit);
      $("#dialog-close").removeEventListener("click", onCancel);
      $("#dialog-cancel").removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdropClick);
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      resolve(value);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const value = input.value.trim();
      const validationMessage = validate(value);
      if (validationMessage) {
        error.textContent = validationMessage;
        input.focus();
        return;
      }
      finish(value);
    };
    const onCancel = () => finish(null);
    const onBackdropClick = (event) => {
      if (event.target === backdrop) onCancel();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") onCancel();
    };
    form.addEventListener("submit", onSubmit);
    $("#dialog-close").addEventListener("click", onCancel);
    $("#dialog-cancel").addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onKeyDown);
  });
}

async function addOfflineProfile() {
  const name = await openInputDialog({
    title: "Créer un profil hors ligne",
    description: "Choisis le pseudo qui apparaîtra dans ton monde Minecraft.",
    label: "PSEUDO",
    placeholder: "Ex. RosePlayer",
    maxLength: 16,
    validate: (value) => /^[A-Za-z0-9_]{3,16}$/.test(value)
      ? ""
      : "Entre 3 et 16 lettres, chiffres ou tirets bas.",
  });
  if (name === null) return false;
  try {
    const result = await window.launcher.addProfile(name);
    renderProfiles(result.profiles, result.selectedProfile);
    if (!state.account) renderAccount(null, result.selectedProfile);
    toast(`Profil ${result.selectedProfile} ajouté.`, "success");
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

async function connectMicrosoftAccount() {
  try {
    toast("Connexion Microsoft en cours…");
    const account = await window.launcher.login();
    renderAccount(account, $("#profile-select").value);
    toast(`Bienvenue, ${account.name} !`, "success");
    return true;
  } catch (error) {
    toast(error.message, "error");
    setStatus(error.message, "error");
    return false;
  }
}

function setStatus(message, kind = "info") {
  $("#status-title").textContent = kind === "error" ? "Oups, petit souci" : kind === "success" ? "C’est prêt !" : "En cours";
  $("#status-message").textContent = message;
  const log = $("#activity-log");
  const entry = document.createElement("div");
  entry.textContent = `› ${message}`;
  log.prepend(entry);
  while (log.children.length > 4) log.lastElementChild.remove();
}

function showPanel(name) {
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
  $("#page-name").textContent = name === "play" ? "JOUER" : name === "mods" ? "DÉCOUVRIR" : name === "friends" ? "AMIS" : "MON SKIN";
}

function renderProfiles(profiles, selected) {
  const select = $("#profile-select");
  select.replaceChildren();
  if (profiles.length === 0) {
    const option = new Option("Aucun profil hors ligne", "");
    select.add(option);
  } else {
    profiles.forEach((name) => select.add(new Option(name, name, false, name === selected)));
  }
  $("#profile-avatar").textContent = selected ? selected[0].toUpperCase() : "?";
}

function renderAccount(account, selectedProfile) {
  state.account = account;
  const online = Boolean(account);
  $("#auth-mode").value = online ? "online" : "offline";
  $("#account-name").textContent = online ? account.name : selectedProfile || "Pas connecté";
  $("#account-mode").textContent = online ? "Compte Microsoft" : "Mode hors ligne";
  $("#account-avatar").textContent = online ? account.name[0].toUpperCase() : "♡";
  $("#top-avatar").textContent = online ? account.name[0].toUpperCase() : "♡";
  $("#account-action").textContent = online ? "Déconnexion" : "Microsoft";
  $("#account-action").title = online ? "Déconnexion Microsoft" : "Connexion Microsoft";
  $("#account-action").setAttribute("aria-label", $("#account-action").title);
  $("#account-action").setAttribute("aria-label", $("#account-action").title);
}

function renderFriends(friends) {
  const list = $("#friend-list");
  list.replaceChildren();
  if (!friends.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("span");
    icon.textContent = "♡";
    const title = document.createElement("strong");
    title.textContent = "Ta liste est vide";
    const description = document.createElement("p");
    description.textContent = "Ajoute un pseudo pour le garder dans ton carnet local.";
    empty.append(icon, title, description);
    list.append(empty);
    return;
  }
  friends.forEach((username) => {
    const row = document.createElement("div");
    row.className = "friend-row";
    const badge = document.createElement("span");
    badge.textContent = "♡";
    const name = document.createElement("strong");
    name.textContent = username;
    const remove = document.createElement("button");
    remove.className = "friend-remove";
    remove.type = "button";
    remove.textContent = "RETIRER";
    remove.addEventListener("click", async () => {
      try {
        const result = await window.launcher.removeFriend(username);
        renderFriends(result.friends);
        toast(`${username} retiré de ta liste locale.`, "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    row.append(badge, name, remove);
    list.append(row);
  });
}

function selectedVersion() {
  return $("#version-select").value;
}

function updateVersionStatus() {
  const status = state.versions.get(selectedVersion());
  const element = $("#version-status");
  updatePvpPackButton();
  if (!status) {
    element.textContent = "Disponibilité non vérifiée";
    element.className = "version-status";
    return;
  }
  element.textContent = status ? "Version disponible" : "Version non publiée";
  element.className = `version-status ${status ? "ready" : "unavailable"}`;
  $("#install-count").textContent = status
    ? ($("#loader-select").value === "fabric" ? "Fabric" : "Vanilla")
    : "Indisponible";
}

function updatePvpPackButton() {
  const button = $("#pvp-pack-button");
  if (!button) return;
  if (state.pvpPackInstalling) {
    button.disabled = true;
    button.textContent = "INSTALLATION…";
    return;
  }
  const key = `${selectedVersion()}:${$("#loader-select").value}`;
  const installed = state.installedPvpVersions.has(key);
  button.disabled = installed;
  button.textContent = installed ? "SPRINT INSTALLÉ ✓" : "INSTALLER";
}

async function loadVersions() {
  try {
    const versions = await window.launcher.getVersions();
    versions.forEach(({ id, available }) => state.versions.set(id, available));
    const select = $("#version-select");
    const previous = select.value;
    select.replaceChildren(...versions.map(({ id }) => new Option(`Minecraft ${id}`, id)));
    select.value = state.versions.has(previous)
      ? previous
      : state.versions.has("1.21.11")
        ? "1.21.11"
        : versions[0]?.id || "";
    updateVersionStatus();
  } catch (error) {
    $("#version-status").textContent = "Vérification impossible";
    toast(error.message, "error");
  }
}

function makeProjectCard(project) {
  const card = document.createElement("article");
  card.className = "result-card";
  const icon = project.icon ? document.createElement("img") : document.createElement("div");
  if (project.icon) {
    icon.src = project.icon;
    icon.alt = "";
    icon.loading = "lazy";
  } else {
    icon.className = "result-icon";
    icon.textContent = project.type === "shader" ? "✧" : project.type === "mod" ? "✿" : "▧";
  }
  const body = document.createElement("div");
  body.className = "result-body";
  const title = document.createElement("h3");
  title.textContent = project.title;
  const description = document.createElement("p");
  description.textContent = project.description || "Aucune description disponible.";
  const bottom = document.createElement("div");
  bottom.className = "result-bottom";
  const downloads = document.createElement("span");
  downloads.textContent = `${Number(project.downloads).toLocaleString("fr-FR")} téléchargements`;
  const button = document.createElement("button");
  button.className = "install-button";
  button.textContent = "Ajouter +";
  button.addEventListener("click", async () => {
    const loader = $("#loader-select").value;
    if (project.type === "mod" && loader !== "fabric") {
      toast("Choisis Fabric dans « Jouer » pour installer des mods.", "error");
      return;
    }
    button.disabled = true;
    button.textContent = "Ajout…";
    try {
      const result = await window.launcher.installModrinth(project.id, project.type, selectedVersion(), loader);
      toast(`${result.filename} ajouté dans ${result.folder}.`, "success");
      button.textContent = "Ajouté ✓";
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Ajouter +";
    }
  });
  bottom.append(downloads, button);
  body.append(title, description, bottom);
  card.append(icon, body);
  return card;
}

async function searchModrinth() {
  const container = $("#mod-results");
  container.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "empty-state";
  loading.innerHTML = "<span>✿</span><strong>Je cherche pour toi…</strong><p>Connexion à Modrinth.</p>";
  container.append(loading);
  try {
    const projects = await window.launcher.searchModrinth($("#mod-search-input").value.trim(), state.activeType);
    container.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<span>♡</span><strong>Rien trouvé pour cette recherche</strong><p>Essaie un autre mot ou une autre catégorie.</p>";
      container.append(empty);
      return;
    }
    projects.forEach((project) => container.append(makeProjectCard(project)));
  } catch (error) {
    container.replaceChildren();
    const failure = document.createElement("div");
    failure.className = "empty-state";
    const text = document.createElement("strong");
    text.textContent = "Modrinth est momentanément inaccessible";
    const detail = document.createElement("p");
    detail.textContent = error.message;
    failure.append(text, detail);
    container.append(failure);
  }
}

async function initialize() {
  try {
    const current = await window.launcher.getState();
    renderProfiles(current.profiles, current.selectedProfile);
    renderAccount(current.account, current.selectedProfile);
    renderFriends(current.friends || []);
    if (current.skin) {
      const image = document.createElement("img");
      image.src = current.skin;
      image.alt = "Aperçu du skin";
      state.skinDataUrl = current.skin;
      $("#skin-preview").replaceChildren(image);
    }
  } catch (error) {
    toast(error.message, "error");
  }
  const darkTheme = localStorage.getItem("femboycraft-theme") === "dark";
  document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
  $("#theme-toggle").setAttribute("aria-pressed", String(darkTheme));
  loadVersions();
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showPanel(button.dataset.panel)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => showPanel(button.dataset.go)));
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  logoClicks += 1;
  clearTimeout(logoClickTimer);
  logoClickTimer = setTimeout(() => { logoClicks = 0; }, 1800);
  if (logoClicks >= 5) {
    logoClicks = 0;
    document.body.classList.add("easter-egg");
    toast("Easter egg : le cœur rose veille sur ton monde ✦", "success");
    setTimeout(() => document.body.classList.remove("easter-egg"), 7000);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === konamiSequence[konamiIndex]) {
    konamiIndex += 1;
    if (konamiIndex === konamiSequence.length) {
      konamiIndex = 0;
      document.body.classList.add("easter-egg");
      toast("Code secret découvert : +1000 tendresse 🌸", "success");
      setTimeout(() => document.body.classList.remove("easter-egg"), 7000);
    }
  } else {
    konamiIndex = event.key === konamiSequence[0] ? 1 : 0;
  }
});
$("#theme-toggle").addEventListener("click", () => {
  const darkTheme = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
  $("#theme-toggle").setAttribute("aria-pressed", String(darkTheme));
  localStorage.setItem("femboycraft-theme", darkTheme ? "dark" : "light");
  toast(darkTheme ? "Thème rose & noir activé." : "Thème pastel activé.", "success");
});
$("#version-select").addEventListener("change", updateVersionStatus);
$("#loader-select").addEventListener("change", updateVersionStatus);
$("#profile-select").addEventListener("change", async (event) => {
  try {
    const result = await window.launcher.selectProfile(event.target.value);
    $("#profile-avatar").textContent = result.selectedProfile[0].toUpperCase();
    if (!state.account) renderAccount(null, result.selectedProfile);
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#add-profile-button").addEventListener("click", async () => {
  await addOfflineProfile();
});
$("#add-friend-button").addEventListener("click", async () => {
  const username = await openInputDialog({
    title: "Ajouter un pseudo",
    description: "Cette liste reste sur cet ordinateur et dans ton interface de jeu.",
    label: "PSEUDO MINECRAFT",
    placeholder: "Ex. RosePlayer",
    maxLength: 16,
    validate: (value) => /^[A-Za-z0-9_]{3,16}$/.test(value) ? "" : "Entre 3 à 16 lettres, chiffres ou tirets bas.",
  });
  if (username === null) return;
  try {
    const result = await window.launcher.addFriend(username);
    renderFriends(result.friends);
    toast(`${username} ajouté à ta liste locale.`, "success");
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#account-action").addEventListener("click", async () => {
  if (state.account) {
    try {
      await window.launcher.logout();
      renderAccount(null, $("#profile-select").value);
      toast("Compte Microsoft déconnecté.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  } else {
    await connectMicrosoftAccount();
  }
});
$("#launch-button").addEventListener("click", async () => {
  const version = selectedVersion();
  if (state.versions.get(version) === false) {
    toast(`Minecraft ${version} n’est pas une version publiée.`, "error");
    return;
  }
  const mode = $("#auth-mode").value;
  if (mode === "online" && !state.account) {
    if (!await connectMicrosoftAccount()) return;
  }
  if (mode === "offline" && !$("#profile-select").value) {
    if (!await addOfflineProfile()) return;
  }
  try {
    await window.launcher.launch({ version, mode, loader: $("#loader-select").value });
    toast(`Lancement de Minecraft ${version}…`, "success");
  } catch (error) {
    toast(error.message, "error");
    setStatus(error.message, "error");
  }
});
$("#mod-search-button").addEventListener("click", searchModrinth);
$("#pvp-pack-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const version = selectedVersion();
  const loader = $("#loader-select").value;
  if (state.versions.get(version) === false) {
    toast(`Minecraft ${version} n’est pas une version publiée.`, "error");
    return;
  }
  if (loader !== "fabric") {
    toast("Choisis Fabric dans « Jouer » pour installer les mods PvP.", "error");
    return;
  }
  state.pvpPackInstalling = true;
  updatePvpPackButton();
  try {
    const result = await window.launcher.installPvpPack(version, loader);
    state.pvpPackInstalling = false;
    state.installedPvpVersions.add(`${version}:${loader}`);
    const skipped = result.skipped.length
      ? ` Non disponibles pour cette version : ${result.skipped.join(", ")}.`
      : "";
    toast(`Pack PvP installé (${result.installed.length} fichiers) pour Minecraft ${version}.${skipped}`, "success");
    updatePvpPackButton();
  } catch (error) {
    state.pvpPackInstalling = false;
    toast(error.message, "error");
    updatePvpPackButton();
  }
});
$("#mod-search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchModrinth();
});
document.querySelectorAll(".category-tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".category-tab").forEach((tab) => tab.classList.toggle("selected", tab === button));
  state.activeType = button.dataset.type;
  if ($("#mod-search-input").value.trim()) searchModrinth();
}));
$("#skin-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.type !== "image/png" || file.size > 2 * 1024 * 1024) {
    toast("Choisis une image PNG de 2 Mo maximum.", "error");
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await window.launcher.saveSkin(reader.result);
      state.skinDataUrl = reader.result;
      const image = document.createElement("img");
      image.src = state.skinDataUrl;
      image.alt = "Aperçu du skin";
      $("#skin-preview").replaceChildren(image);
      toast("Skin enregistré sur cet ordinateur.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  };
  reader.readAsDataURL(file);
});
$("#upload-skin-button").addEventListener("click", async () => {
  try {
    await window.launcher.uploadSkin($("#skin-variant").value);
    toast("Ton skin a été appliqué au compte Minecraft.", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});
window.launcher.onStatus(({ message, kind }) => setStatus(message, kind));

initialize();
