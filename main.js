const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const yauzl = require("yauzl");
const { Auth } = require("msmc");
const {
  AuthModes,
  asMinecraftVersionId,
  MinecraftKit,
  Loaders,
  createPersistentMetadataCache,
  isMinecraftKitError,
  SkinVariantInputs,
} = require("@loontail/minecraft-kit");

const modrinthApi = "https://api.modrinth.com/v2";
const modrinthHeaders = { "User-Agent": "FemboyCraft/1.0.0" };
const oneClientProjectId = "QhX1nx34";
const oneClientVersionId = "GoCGvSml";
const oneClientMinecraftVersion = "1.21.11";
const oneClientFabricLoaderVersion = "0.20.1";
const oneClientManifestRevision = 1;
const pvpAddonProjects = ["gQ6IIk5e"];
const retiredHudModFilenamePrefixes = [
  "afkzmotionblur-",
  "armor_hud-fabric-",
  "armor-hud-",
  "clean-keystrokes-",
  "compose-bundle-",
  "dynamiccrosshair-",
  "dynamic-crosshair-",
  "evergreenhud-",
  "evergreen-hud-",
  "hudfabric-",
  "motionblur-",
  "motion-blur-",
  "oneconfig-",
  "ownnametag-",
  "own-nametag-",
  "ping-hud-",
  "potion-hud-display-",
  "potionhud-",
  "selfnametag-",
];
const retiredHudModCleanupRevision = 1;
const clientModpackRevision = 2;
const clientModGroups = [
  { name: "Sodium", projects: ["AANobbMI"] },
  { name: "Lithium", projects: ["gvQqBUqZ"] },
  { name: "Entity Culling", projects: ["NNAgCjsB"] },
  { name: "Zoomify", projects: ["w7ThoJFB"] },
  { name: "3D Skin Layers", projects: ["zV5r3pPn"] },
];
let kit;
let window;
let versionManifestCache;
let versionManifestFetchedAt = 0;

function dataPath(name) {
  return path.join(app.getPath("userData"), name);
}

async function readState() {
  let state;
  try {
    state = JSON.parse(await fs.readFile(dataPath("settings.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      state = { profiles: [], selectedProfile: "", skin: "", account: null, friends: [] };
    } else {
      throw error;
    }
  }
  return state;
}

async function getVersionManifest() {
  if (!versionManifestCache || Date.now() - versionManifestFetchedAt > 30 * 60 * 1000) {
    const response = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
    if (!response.ok) throw new Error(`Le manifeste Minecraft a répondu ${response.status}.`);
    versionManifestCache = await response.json();
    versionManifestFetchedAt = Date.now();
  }
  return versionManifestCache;
}

async function isPublishedRelease(version) {
  if (typeof version !== "string") return false;
  const manifest = await getVersionManifest();
  return manifest.versions.some((entry) => entry.type === "release" && entry.id === version);
}

function getLocalFriends(state) {
  return Array.isArray(state.friends)
    ? state.friends.filter((name) => validateProfileName(name))
    : [];
}

async function writeState(state) {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(dataPath("settings.json"), JSON.stringify(state, null, 2), "utf8");
}

function sendStatus(message, kind = "info") {
  if (window && !window.isDestroyed()) {
    window.webContents.send("launcher:status", { message, kind });
  }
}

function validateProfileName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
}

async function readResponseLimited(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > limit) {
      throw new Error(`Le fichier dépasse la limite de téléchargement de ${Math.ceil(limit / (1024 * 1024))} Mo.`);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks, size);
}

async function modrinthJson(url) {
  const response = await fetch(url, { headers: modrinthHeaders });
  if (!response.ok) throw new Error(`Modrinth a répondu ${response.status}.`);
  return response.json();
}

async function addModrinthRelease(release, gameVersion, loader, resolved, resolving) {
  const projectId = release.project_id;
  if (!projectId || resolving.has(projectId)) return;
  if (resolved.has(projectId)) {
    if (release.id && resolved.get(projectId).versionId !== release.id) {
      throw new Error(`Modrinth exige deux versions incompatibles du projet ${projectId}.`);
    }
    return;
  }
  if (!release.game_versions.includes(gameVersion) || !release.loaders.includes(loader)) {
    throw new Error(`Une dépendance requise par ${projectId} n’est pas compatible avec Minecraft ${gameVersion}.`);
  }
  resolving.add(projectId);
  for (const dependency of release.dependencies || []) {
    if (dependency.dependency_type !== "required") continue;
    let dependencyRelease;
    if (dependency.version_id) {
      dependencyRelease = await modrinthJson(`${modrinthApi}/version/${encodeURIComponent(dependency.version_id)}`);
    } else if (dependency.project_id) {
      const url = new URL(`${modrinthApi}/project/${encodeURIComponent(dependency.project_id)}/version`);
      url.searchParams.set("game_versions", JSON.stringify([gameVersion]));
      url.searchParams.set("loaders", JSON.stringify([loader]));
      const candidates = await modrinthJson(url);
      dependencyRelease = candidates.find((item) => item.files && item.files.length > 0);
      if (!dependencyRelease) {
        throw new Error(`Aucune version compatible de la dépendance requise ${dependency.project_id} pour Minecraft ${gameVersion}.`);
      }
    }
    if (dependencyRelease) await addModrinthRelease(dependencyRelease, gameVersion, loader, resolved, resolving);
  }

  const file = (release.files || []).find((item) => item.primary) || (release.files || [])[0];
  if (!file || !file.url || !file.filename) throw new Error(`Fichier de mod invalide pour ${projectId}.`);
  const project = await modrinthJson(`${modrinthApi}/project/${encodeURIComponent(projectId)}`);
  resolved.set(projectId, { title: project.title, file, versionId: release.id });
  resolving.delete(projectId);
}

async function resolveModrinthFiles(projectId, gameVersion, loader, resolved = new Map(), resolving = new Set()) {
  if (resolved.has(projectId) || resolving.has(projectId)) return resolved;
  const url = new URL(`${modrinthApi}/project/${encodeURIComponent(projectId)}/version`);
  url.searchParams.set("game_versions", JSON.stringify([gameVersion]));
  url.searchParams.set("loaders", JSON.stringify([loader]));
  const releases = await modrinthJson(url);
  const release = releases.find((item) => item.files && item.files.length > 0);
  if (!release) {
    throw new Error(`Aucune version ${loader} de ${projectId} n’est compatible avec Minecraft ${gameVersion}.`);
  }
  await addModrinthRelease(release, gameVersion, loader, resolved, resolving);
  return resolved;
}

async function resolveOptionalModrinthFiles(projectId, gameVersion, loader, resolved) {
  const url = new URL(`${modrinthApi}/project/${encodeURIComponent(projectId)}/version`);
  url.searchParams.set("game_versions", JSON.stringify([gameVersion]));
  url.searchParams.set("loaders", JSON.stringify([loader]));
  const releases = await modrinthJson(url);
  const compatibleReleases = releases.filter((item) => item.files && item.files.length > 0);
  if (!compatibleReleases.length) {
    const project = await modrinthJson(`${modrinthApi}/project/${encodeURIComponent(projectId)}`);
    return project.title;
  }
  for (const release of compatibleReleases) {
    const candidate = new Map(resolved);
    try {
      await addModrinthRelease(release, gameVersion, loader, candidate, new Set());
    } catch (error) {
      if (
        error instanceof Error
        && /^(Modrinth exige deux versions incompatibles|Une dépendance requise par|Aucune version compatible de la dépendance requise)/.test(error.message)
      ) {
        continue;
      }
      throw error;
    }
    for (const [id, file] of candidate) resolved.set(id, file);
    return null;
  }
  const project = await modrinthJson(`${modrinthApi}/project/${encodeURIComponent(projectId)}`);
  return project.title;
}

async function installModrinthFiles(files, destination) {
  await fs.mkdir(destination, { recursive: true });
  const installed = [];
  for (const { title, file } of files.values()) {
    const filename = path.basename(file.filename);
    if (!filename || filename === "." || filename === ".." || !file.url.startsWith("https://")) {
      throw new Error(`Fichier de mod invalide pour ${title}.`);
    }
    const destinationPath = path.join(destination, filename);
    if (file.hashes?.sha1) {
      try {
        const stats = await fs.stat(destinationPath);
        if (stats.isFile()) {
          const hash = createHash("sha1");
          for await (const chunk of createReadStream(destinationPath)) hash.update(chunk);
          if (hash.digest("hex") === file.hashes.sha1.toLowerCase()) {
            installed.push(filename);
            continue;
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const response = await fetch(file.url, { headers: modrinthHeaders });
    if (!response.ok) throw new Error(`Le téléchargement de ${title} a échoué (${response.status}).`);
    const data = await readResponseLimited(response, 512 * 1024 * 1024);
    await fs.writeFile(destinationPath, data);
    installed.push(filename);
  }
  return installed;
}

function isSafeModFilename(filename) {
  return typeof filename === "string"
    && filename.length > 0
    && filename !== "."
    && filename !== ".."
    && path.basename(filename) === filename;
}

function getSafeOneClientPath(filename) {
  if (typeof filename !== "string" || filename.includes("\\") || filename.includes("\0")) {
    throw new Error("Le manifeste OneClient contient un chemin invalide.");
  }
  const parts = filename.split("/");
  if (
    parts.length !== 2
    || !["mods", "shaderpacks"].includes(parts[0])
    || !isSafeModFilename(parts[1])
  ) {
    throw new Error(`Chemin OneClient non pris en charge : ${filename}.`);
  }
  return filename;
}

function normalizeOneClientFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Le manifeste OneClient ne contient aucun fichier.");
  }
  const seen = new Set();
  return files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error("Le manifeste OneClient contient une entrée invalide.");
    }
    const relativePath = getSafeOneClientPath(file.path);
    if (
      !Number.isSafeInteger(file.size)
      || file.size < 0
      || file.size > 512 * 1024 * 1024
      || typeof file.sha1 !== "string"
      || !/^[0-9a-f]{40}$/i.test(file.sha1)
      || seen.has(relativePath)
    ) {
      throw new Error(`Entrée OneClient invalide : ${relativePath}.`);
    }
    seen.add(relativePath);
    return { path: relativePath, size: file.size, sha1: file.sha1.toLowerCase() };
  });
}

function readOneClientArchive(archive) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, autoClose: false }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }
      let settled = false;
      let indexBuffer;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };
      zipFile.on("error", fail);
      zipFile.on("entry", (entry) => {
        if (
          (entry.fileName.startsWith("overrides/") || entry.fileName.startsWith("client-overrides/"))
          && !entry.fileName.endsWith("/")
        ) {
          fail(new Error("Le pack OneClient contient des overrides non pris en charge."));
          return;
        }
        if (entry.fileName !== "modrinth.index.json") {
          zipFile.readEntry();
          return;
        }
        if (indexBuffer) {
          fail(new Error("L’archive OneClient contient plusieurs manifestes."));
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          const chunks = [];
          let size = 0;
          stream.on("data", (chunk) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
              stream.destroy(new Error("Le manifeste OneClient dépasse la taille autorisée."));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (settled) return;
            indexBuffer = Buffer.concat(chunks, size);
            zipFile.readEntry();
          });
        });
      });
      zipFile.on("end", () => {
        if (settled) return;
        if (!indexBuffer) {
          fail(new Error("Le manifeste modrinth.index.json est absent du pack OneClient."));
          return;
        }
        let manifest;
        try {
          manifest = JSON.parse(indexBuffer.toString("utf8"));
        } catch (error) {
          fail(new Error("Le manifeste OneClient n’est pas un JSON valide.", { cause: error }));
          return;
        }
        if (
          !manifest
          || typeof manifest !== "object"
          || Array.isArray(manifest)
          || manifest.formatVersion !== 1
          || !Array.isArray(manifest.files)
          || manifest.dependencies?.minecraft !== oneClientMinecraftVersion
          || manifest.dependencies?.["fabric-loader"] !== oneClientFabricLoaderVersion
        ) {
          fail(new Error("La version Minecraft ou Fabric du pack OneClient ne correspond pas à cette instance."));
          return;
        }
        settled = true;
        zipFile.close();
        resolve(manifest);
      });
      zipFile.readEntry();
    });
  });
}

async function downloadOneClientFiles(files, stageDirectory) {
  let nextIndex = 0;
  let completed = 0;
  let failure;
  const worker = async () => {
    while (!failure) {
      const index = nextIndex++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const url = file.downloads.find((candidate) => {
          try {
            return new URL(candidate).protocol === "https:";
          } catch {
            return false;
          }
        });
        if (!url) throw new Error(`Aucune URL HTTPS valide pour ${file.path}.`);
        const response = await fetch(url, { headers: modrinthHeaders });
        if (!response.ok) throw new Error(`Le téléchargement de ${file.path} a échoué (${response.status}).`);
        const data = await readResponseLimited(response, 512 * 1024 * 1024);
        if (data.length !== file.size) throw new Error(`La taille de ${file.path} ne correspond pas au manifeste OneClient.`);
        const hash = createHash("sha1").update(data).digest("hex");
        if (hash !== file.sha1) throw new Error(`La vérification SHA-1 de ${file.path} a échoué.`);
        const destination = path.join(stageDirectory, ...file.path.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, data);
        completed += 1;
        if (completed % 5 === 0 || completed === files.length) {
          sendStatus(`Installation OneClient : ${completed}/${files.length} fichiers vérifiés…`);
        }
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, () => worker()));
  if (failure) throw failure;
}

async function getOneClientFileSha1(filename) {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function installOneClientModpack(directory) {
  const modsDirectory = path.join(directory, "mods");
  const configDirectory = path.join(directory, "config");
  const manifestPath = path.join(configDirectory, "femboycraft-oneclient.json");
  let previousManifest;
  try {
    previousManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let previousFiles = [];
  if (previousManifest !== undefined) {
    if (!previousManifest || typeof previousManifest !== "object" || Array.isArray(previousManifest)) {
      throw new Error("Le manifeste local OneClient est invalide.");
    }
    previousFiles = normalizeOneClientFiles(previousManifest.files);
    if (
      previousManifest.revision === oneClientManifestRevision
      && previousManifest.minecraftVersion === oneClientMinecraftVersion
      && previousManifest.packVersionId === oneClientVersionId
    ) {
      let complete = true;
      for (const file of previousFiles) {
        const filename = path.join(directory, ...file.path.split("/"));
        try {
          const stats = await fs.stat(filename);
          if (!stats.isFile() || stats.size !== file.size || await getOneClientFileSha1(filename) !== file.sha1) {
            complete = false;
            break;
          }
        } catch (error) {
          if (error.code === "ENOENT") complete = false;
          else throw error;
          break;
        }
      }
      if (complete) return { cached: true, fileCount: previousFiles.length };
    }
  }

  const release = await modrinthJson(`${modrinthApi}/version/${encodeURIComponent(oneClientVersionId)}`);
  if (
    release.project_id !== oneClientProjectId
    || !release.game_versions?.includes(oneClientMinecraftVersion)
    || !release.loaders?.includes("fabric")
  ) {
    throw new Error("La version OneClient sélectionnée n’est pas compatible avec Minecraft 1.21.11 Fabric.");
  }
  const archiveFile = (release.files || []).find((file) => file.primary) || (release.files || [])[0];
  if (!archiveFile?.url?.startsWith("https://") || !archiveFile.hashes?.sha1) {
    throw new Error("Le fichier du pack OneClient est invalide.");
  }
  sendStatus("Téléchargement du pack OneClient…");
  const archiveResponse = await fetch(archiveFile.url, { headers: modrinthHeaders });
  if (!archiveResponse.ok) throw new Error(`Le téléchargement du pack OneClient a échoué (${archiveResponse.status}).`);
  const archive = await readResponseLimited(archiveResponse, 32 * 1024 * 1024);
  if (archiveFile.size && archive.length !== archiveFile.size) {
    throw new Error("La taille du pack OneClient ne correspond pas à Modrinth.");
  }
  if (createHash("sha1").update(archive).digest("hex") !== archiveFile.hashes.sha1.toLowerCase()) {
    throw new Error("La vérification SHA-1 du pack OneClient a échoué.");
  }
  const pack = await readOneClientArchive(archive);
  const packFiles = normalizeOneClientFiles(
    (pack.files || [])
      .filter((file) => file.env?.client !== "unsupported")
      .map((file) => ({
        path: file.path,
        size: file.fileSize,
        sha1: file.hashes?.sha1,
      })),
  );
  const totalSize = packFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > 1024 * 1024 * 1024) throw new Error("La taille totale du pack OneClient dépasse 1 Go.");
  const downloadsByPath = new Map(
    (pack.files || [])
      .filter((file) => file.env?.client !== "unsupported")
      .map((file) => [file.path, file.downloads]),
  );
  const filesToDownload = packFiles.map((file) => ({
    ...file,
    downloads: downloadsByPath.get(file.path),
  }));
  if (filesToDownload.some((file) => !Array.isArray(file.downloads) || file.downloads.length === 0)) {
    throw new Error("Le manifeste OneClient contient un fichier sans URL de téléchargement.");
  }

  await fs.mkdir(directory, { recursive: true });
  const stageDirectory = await fs.mkdtemp(path.join(directory, ".femboycraft-oneclient-"));
  try {
    sendStatus(`Téléchargement des ${filesToDownload.length} fichiers du pack OneClient…`);
    await downloadOneClientFiles(filesToDownload, stageDirectory);

    const newPaths = new Set(packFiles.map((file) => file.path));
    const oldClientManifestPath = path.join(configDirectory, "femboycraft-client-mods.json");
    let oldClientManifest;
    try {
      oldClientManifest = JSON.parse(await fs.readFile(oldClientManifestPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      oldClientManifest !== undefined
      && (
        !oldClientManifest
        || typeof oldClientManifest !== "object"
        || Array.isArray(oldClientManifest)
        || !oldClientManifest.projects
        || typeof oldClientManifest.projects !== "object"
        || Array.isArray(oldClientManifest.projects)
      )
    ) {
      throw new Error("Le manifeste local des mods est invalide.");
    }
    for (const filename of Object.values(oldClientManifest?.projects || {})) {
      if (!isSafeModFilename(filename)) throw new Error("Le manifeste local des mods est invalide.");
      await fs.rm(path.join(modsDirectory, filename), { force: true });
    }
    for (const file of previousFiles) {
      if (!newPaths.has(file.path)) {
        await fs.rm(path.join(directory, ...file.path.split("/")), { force: true });
      }
    }
    for (const file of packFiles) {
      const source = path.join(stageDirectory, ...file.path.split("/"));
      const destination = path.join(directory, ...file.path.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }

    await fs.rm(oldClientManifestPath, { force: true });
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({
      revision: oneClientManifestRevision,
      minecraftVersion: oneClientMinecraftVersion,
      packVersionId: oneClientVersionId,
      files: packFiles,
    }, null, 2), "utf8");
    return { cached: false, fileCount: packFiles.length };
  } finally {
    await fs.rm(stageDirectory, { recursive: true, force: true });
  }
}

async function installClientModpack(directory, version) {
  const modsDirectory = path.join(directory, "mods");
  const manifestPath = path.join(directory, "config", "femboycraft-client-mods.json");
  let previousManifest;
  try {
    previousManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (
    previousManifest?.revision === clientModpackRevision
    && previousManifest.minecraftVersion === version
    && previousManifest.projects
    && typeof previousManifest.projects === "object"
    && !Array.isArray(previousManifest.projects)
  ) {
    if (!Array.isArray(previousManifest.skipped) || !previousManifest.skipped.every((name) => typeof name === "string")) {
      throw new Error("Le manifeste local des mods est invalide.");
    }
    let complete = true;
    for (const filename of Object.values(previousManifest.projects)) {
      if (!isSafeModFilename(filename)) throw new Error("Le manifeste local des mods est invalide.");
      try {
        const stats = await fs.stat(path.join(modsDirectory, filename));
        if (!stats.isFile()) complete = false;
      } catch (error) {
        if (error.code === "ENOENT") complete = false;
        else throw error;
      }
      if (!complete) break;
    }
    if (complete) return { skipped: previousManifest.skipped || [], cached: true };
  }

  const files = new Map();
  const skipped = [];
  for (const group of clientModGroups) {
    if (group.versions && !group.versions.includes(version)) continue;
    let installed = false;
    for (const projectId of group.projects) {
      const unavailable = await resolveOptionalModrinthFiles(projectId, version, "fabric", files);
      if (!unavailable) {
        installed = true;
        break;
      }
    }
    if (!installed) skipped.push(group.name);
  }

  const installedFiles = await installModrinthFiles(files, modsDirectory);
  const projectFiles = Object.fromEntries(
    Array.from(files, ([projectId, entry]) => [projectId, path.basename(entry.file.filename)]),
  );
  const currentFilenames = new Set(Object.values(projectFiles));
  const previousProjects = previousManifest?.projects;
  if (previousProjects && typeof previousProjects === "object" && !Array.isArray(previousProjects)) {
    for (const filename of Object.values(previousProjects)) {
      if (isSafeModFilename(filename) && !currentFilenames.has(filename)) {
        await fs.rm(path.join(modsDirectory, filename), { force: true });
      }
    }
  }
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({
    revision: clientModpackRevision,
    minecraftVersion: version,
    projects: projectFiles,
    skipped,
  }, null, 2), "utf8");
  return { skipped, installedFiles, cached: false };
}

async function removeRetiredHudMods(directory) {
  const migrationPath = path.join(directory, "config", "femboycraft-hud-mod-cleanup.json");
  let migration;
  try {
    migration = JSON.parse(await fs.readFile(migrationPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (Number.isInteger(migration?.revision) && migration.revision >= retiredHudModCleanupRevision) return;

  const modsDirectory = path.join(directory, "mods");
  let entries;
  try {
    entries = await fs.readdir(modsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") entries = [];
    else throw error;
  }
  for (const entry of entries) {
    const filename = entry.name.toLowerCase();
    if (
      entry.isFile()
      && retiredHudModFilenamePrefixes.some((prefix) => filename.startsWith(prefix))
    ) {
      await fs.rm(path.join(modsDirectory, entry.name), { force: true });
    }
  }
  await fs.mkdir(path.dirname(migrationPath), { recursive: true });
  await fs.writeFile(
    migrationPath,
    JSON.stringify({ revision: retiredHudModCleanupRevision }),
    "utf8",
  );
}

function getGameMemoryOptions() {
  const totalMemoryMb = Math.floor(os.totalmem() / (1024 * 1024));
  const maxMb = Math.max(2048, Math.min(6144, Math.floor((totalMemoryMb * 0.4) / 256) * 256));
  return { minMb: 1024, maxMb };
}

async function assertSafeStorageAvailable() {
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error("Le stockage sécurisé de Windows n’est pas disponible.");
  }
}

async function getAccountSession(account) {
  if (!account || !account.encryptedSession) return null;
  await assertSafeStorageAvailable();
  const encrypted = Buffer.from(account.encryptedSession, "base64");
  let decrypted = await safeStorage.decryptStringAsync(encrypted);
  if (decrypted.shouldReEncrypt) {
    decrypted = await safeStorage.decryptStringAsync(encrypted);
  }
  return JSON.parse(decrypted.result);
}

async function saveAccountSession(state, session) {
  await assertSafeStorageAvailable();
  state.account = {
    name: session.profile.name,
    encryptedSession: (await safeStorage.encryptStringAsync(JSON.stringify(session))).toString("base64"),
  };
}

function onlineAuthorization(session) {
  const rawUuid = session.profile.id.replace(/-/g, "");
  const uuid = /^[0-9a-f]{32}$/i.test(rawUuid)
    ? `${rawUuid.slice(0, 8)}-${rawUuid.slice(8, 12)}-${rawUuid.slice(12, 16)}-${rawUuid.slice(16, 20)}-${rawUuid.slice(20)}`
    : null;
  if (!uuid || !session.mcToken || !session.profile.name) {
    throw new Error("Microsoft n’a pas renvoyé un profil Minecraft valide.");
  }
  return {
    mode: AuthModes.ONLINE,
    username: session.profile.name,
    uuid,
    accessToken: session.mcToken,
    userType: "msa",
    xuid: session.xuid,
  };
}

async function removeLegacyFemboyClientMod(directory, version) {
  if (!["1.21.11", "1.20.4", "1.20.1"].includes(version)) return;
  const filename = `femboycraft-client-${version}-1.0.0.jar`;
  await fs.rm(path.join(directory, "mods", filename), { force: true });
}

async function installFabricMods(directory, version, loader) {
  if (loader !== Loaders.FABRIC) return;
  await removeRetiredHudMods(directory);
  await removeLegacyFemboyClientMod(directory, version);
  if (version === oneClientMinecraftVersion) {
    const result = await installOneClientModpack(directory);
    const status = result.cached
      ? "Pack OneClient déjà installé pour Minecraft 1.21.11."
      : `Pack OneClient installé (${result.fileCount} fichiers, mods et shaders) pour Minecraft 1.21.11.`;
    sendStatus(status, "success");
    return;
  }
  const result = await installClientModpack(directory, version);
  const notices = [...result.skipped];
  const status = notices.length
    ? `Mods du client installés partiellement pour Minecraft ${version} : ${notices.join(", ")}.`
    : `Mods Fabric installés pour Minecraft ${version}.`;
  sendStatus(
    result.cached && !notices.length
      ? `Mods du client déjà installés pour Minecraft ${version}.`
      : status,
    notices.length ? "info" : "success",
  );
}

async function freshAccountSession(state) {
  const saved = await getAccountSession(state.account);
  if (!saved) return null;
  if (saved.exp > Date.now() + 60_000) return saved;
  if (typeof saved.refresh !== "string" || !saved.refresh) {
    throw new Error("Reconnecte ton compte Microsoft pour renouveler la session.");
  }
  const auth = new Auth("select_account");
  const xbox = await auth.refresh(saved.refresh);
  const minecraft = await xbox.getMinecraft();
  const refreshed = minecraft.getToken(true);
  if (!refreshed.refresh) throw new Error("Microsoft n’a pas fourni de jeton de renouvellement.");
  await saveAccountSession(state, refreshed);
  await writeState(state);
  return refreshed;
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#fff8fc",
    title: "Femboy-Craft",
    icon: path.join(__dirname, "assets", "femboycraft.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  await window.loadFile(path.join(__dirname, "index.html"));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("app:state", async () => {
  const state = await readState();
  let skin = "";
  if (state.skin) skin = `data:image/png;base64,${(await fs.readFile(state.skin)).toString("base64")}`;
  return {
    profiles: state.profiles,
    selectedProfile: state.selectedProfile,
    skin,
    friends: getLocalFriends(state),
    account: state.account ? { name: state.account.name } : null,
  };
});

ipcMain.handle("app:versions", async () => {
  const manifest = await getVersionManifest();
  return manifest.versions
    .filter((version) => version.type === "release")
    .map((version) => ({ id: version.id, available: true }));
});

ipcMain.handle("profile:add", async (_event, username) => {
  if (!validateProfileName(username)) {
    throw new Error("Le pseudo hors ligne doit contenir 3 à 16 lettres, chiffres ou tirets bas.");
  }
  const state = await readState();
  if (!state.profiles.includes(username)) state.profiles.push(username);
  state.selectedProfile = username;
  await writeState(state);
  return { profiles: state.profiles, selectedProfile: state.selectedProfile };
});

ipcMain.handle("profile:select", async (_event, username) => {
  const state = await readState();
  if (!state.profiles.includes(username)) throw new Error("Ce profil n’existe pas.");
  state.selectedProfile = username;
  await writeState(state);
  return { selectedProfile: state.selectedProfile };
});

ipcMain.handle("friend:add", async (_event, username) => {
  if (!validateProfileName(username)) throw new Error("Le pseudo doit contenir 3 à 16 lettres, chiffres ou tirets bas.");
  const state = await readState();
  const friends = getLocalFriends(state);
  if (friends.some((friend) => friend.toLowerCase() === username.toLowerCase())) {
    throw new Error("Ce pseudo est déjà dans ta liste locale.");
  }
  state.friends = [...friends, username];
  await writeState(state);
  return { friends: state.friends };
});

ipcMain.handle("friend:remove", async (_event, username) => {
  if (!validateProfileName(username)) throw new Error("Pseudo d’ami invalide.");
  const state = await readState();
  state.friends = getLocalFriends(state).filter((friend) => friend !== username);
  await writeState(state);
  return { friends: state.friends };
});

ipcMain.handle("account:login", async () => {
  const state = await readState();
  await assertSafeStorageAvailable();
  sendStatus("Ouverture de la connexion Microsoft…");
  const auth = new Auth("select_account");
  const xbox = await auth.launch("electron", { width: 520, height: 720, resizable: true });
  const minecraft = await xbox.getMinecraft();
  const session = minecraft.getToken(true);
  if (!session.profile || !session.profile.id || !session.profile.name) {
    throw new Error("Microsoft n’a pas renvoyé un profil Minecraft valide.");
  }
  if (!session.refresh) throw new Error("Microsoft n’a pas fourni de jeton de renouvellement.");
  const entitlements = await minecraft.entitlements();
  if (!entitlements.includes("game_minecraft") && !entitlements.includes("product_minecraft")) {
    throw new Error("Ce compte ne semble pas posséder Minecraft Java.");
  }
  await saveAccountSession(state, session);
  await writeState(state);
  sendStatus(`Compte Microsoft connecté : ${session.profile.name}.`, "success");
  return { name: session.profile.name };
});

ipcMain.handle("account:logout", async () => {
  const state = await readState();
  state.account = null;
  await writeState(state);
  return true;
});

ipcMain.handle("game:launch", async (_event, options) => {
  const version = options.version;
  if (!await isPublishedRelease(version)) throw new Error("Choisis une version officielle stable de Minecraft.");
  if (!["vanilla", "fabric"].includes(options.loader)) throw new Error("Chargeur Minecraft invalide.");
  if (!["offline", "online"].includes(options.mode)) throw new Error("Mode de connexion invalide.");
  const loader = options.loader === "vanilla" ? Loaders.VANILLA : Loaders.FABRIC;
  const state = await readState();
  let auth;
  if (options.mode === "offline") {
    if (!state.selectedProfile) throw new Error("Crée d’abord un profil hors ligne.");
    auth = { mode: AuthModes.OFFLINE, username: state.selectedProfile };
  } else {
    const session = await freshAccountSession(state);
    if (!session) throw new Error("Connecte un compte Microsoft avant de jouer en ligne.");
    auth = onlineAuthorization(session);
  }

  const directory = dataPath(path.join("instances", `${version}-${loader}`));
  const friendsDirectory = path.join(directory, "config");
  await fs.mkdir(friendsDirectory, { recursive: true });
  const friends = getLocalFriends(state);
  await fs.writeFile(path.join(friendsDirectory, "femboycraft-friends.txt"), friends.length ? `${friends.join("\n")}\n` : "", "utf8");
  const target = await kit.targets.resolve({
    id: `${version}-${loader}`,
    directory,
    minecraft: { version: asMinecraftVersionId(version) },
    loader: {
      type: loader,
      ...(version === oneClientMinecraftVersion && loader === Loaders.FABRIC
        ? { version: oneClientFabricLoaderVersion }
        : {}),
    },
  });
  sendStatus(`Préparation de Minecraft ${version} (${loader})…`);
  await installFabricMods(directory, version, loader);
  const readiness = await kit.launch.preflight(target);
  if (!readiness.isReady) {
    const plan = await kit.install.plan(target);
    const lastProgressAt = new Map();
    let attempt = 0;
    while (true) {
      try {
        await kit.install.run(plan, {
          onEvent: (event) => {
            if (event.type === "install:phase-changed") sendStatus(`Installation : ${event.phase}`);
            if (event.type === "download:started") {
              sendStatus(`Téléchargement : ${path.basename(event.file.target)}`);
            }
            if (event.type === "download:progress" && event.totalBytes > 0) {
              const percent = Math.floor((event.bytesDownloaded / event.totalBytes) * 100);
              const lastSentAt = lastProgressAt.get(event.file.target) || 0;
              if (percent === 100 || Date.now() - lastSentAt >= 700) {
                lastProgressAt.set(event.file.target, Date.now());
                sendStatus(`Téléchargement : ${path.basename(event.file.target)} (${percent} %)`);
              }
            }
            if (event.type === "download:failed") {
              sendStatus(
                `Téléchargement interrompu : ${path.basename(event.file.target)}${event.willRetry ? " — nouvelle tentative…" : ""}`,
                "error",
              );
            }
          },
        });
        break;
      } catch (error) {
        const retryableNetworkError = isMinecraftKitError(error)
          && (["NETWORK_TIMEOUT", "NETWORK_ABORTED"].includes(error.code)
            || (error.code === "NETWORK_HTTP_ERROR"
              && (error.context.httpStatus === 408
                || error.context.httpStatus === 425
                || error.context.httpStatus === 429
                || error.context.httpStatus >= 500)));
        if (!retryableNetworkError) throw error;
        if (attempt >= 2) {
          const filename = error.context.filePath ? path.basename(error.context.filePath) : "fichier Minecraft";
          throw new Error(`Échec du téléchargement de ${filename} après 3 tentatives. Vérifie ta connexion puis relance. ${error.message}`, { cause: error });
        }
        attempt += 1;
        const filename = error.context.filePath ? path.basename(error.context.filePath) : "fichier Minecraft";
        sendStatus(`Connexion instable (${filename}). Nouvelle tentative ${attempt}/2…`, "error");
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }
  }
  const availableMemoryMb = Math.floor(os.freemem() / (1024 * 1024));
  const composition = await kit.launch.compose(target, {
    auth,
    memory: getGameMemoryOptions(),
    launcherName: "Femboy-Craft",
    launcherVersion: app.getVersion(),
  });
  const session = kit.launch.run(composition, {
    onEvent: (event) => {
      if (event.type === "process:started") sendStatus("Minecraft est lancé.", "success");
    },
  });
  sendStatus(`Minecraft ${version} est lancé (PID ${session.pid}).`, "success");
  if (availableMemoryMb < 1024) {
    sendStatus("Mémoire disponible faible : ferme les autres applications et vérifie le fichier d’échange Windows.", "error");
  }
  session.exited.then((exit) => {
    const normal = exit.code === 0;
    sendStatus(
      normal ? "Minecraft s’est fermé normalement." : `Minecraft s’est fermé (code ${exit.code ?? exit.signal ?? "inconnu"}).`,
      normal ? "success" : "error",
    );
  }).catch((error) => sendStatus(error.message, "error"));
  return { started: true, pid: session.pid };
});

ipcMain.handle("modrinth:search", async (_event, query, projectType) => {
  const allowedTypes = ["mod", "shader", "resourcepack", "datapack"];
  if (!allowedTypes.includes(projectType)) throw new Error("Catégorie Modrinth invalide.");
  const url = new URL(`${modrinthApi}/search`);
  url.searchParams.set("query", String(query || "").slice(0, 100));
  url.searchParams.set("limit", "12");
  url.searchParams.set("facets", JSON.stringify([[`project_type:${projectType}`]]));
  const response = await fetch(url, { headers: modrinthHeaders });
  if (!response.ok) throw new Error(`Modrinth a répondu ${response.status}.`);
  const result = await response.json();
  return result.hits.map((project) => ({
    id: project.project_id,
    slug: project.slug,
    title: project.title,
    description: project.description,
    icon: project.icon_url,
    downloads: project.downloads,
    type: project.project_type,
  }));
});

ipcMain.handle("modrinth:install", async (_event, projectId, projectType, version, loader) => {
  if (!await isPublishedRelease(version)) throw new Error("Choisis une version officielle stable de Minecraft.");
  if (!["vanilla", "fabric"].includes(loader)) throw new Error("Chargeur Minecraft invalide.");
  if (projectType === "mod" && loader !== "fabric") throw new Error("Les mods doivent être installés avec Fabric.");
  const folders = {
    mod: "mods",
    shader: "shaderpacks",
    resourcepack: "resourcepacks",
    datapack: path.join("saves", "Modrinth", "datapacks"),
  };
  const folder = folders[projectType];
  if (!folder || !/^[\w-]+$/.test(projectId)) throw new Error("Projet Modrinth invalide.");
  const url = new URL(`${modrinthApi}/project/${projectId}/version`);
  url.searchParams.set("game_versions", JSON.stringify([version]));
  if (projectType === "mod") url.searchParams.set("loaders", JSON.stringify([loader]));

  const response = await fetch(url, { headers: modrinthHeaders });
  if (!response.ok) throw new Error(`Modrinth a répondu ${response.status}.`);
  const releases = await response.json();
  const release = releases.find((item) => item.files && item.files.length > 0);
  if (!release) {
    throw new Error(`Aucun fichier compatible avec Minecraft ${version} pour ce chargeur.`);
  }

  const file = release.files.find((item) => item.primary) || release.files[0];
  if (!file.url || !file.url.startsWith("https://") || !file.filename) {
    throw new Error("Modrinth a renvoyé un fichier de téléchargement invalide.");
  }
  const download = await fetch(file.url, { headers: modrinthHeaders });
  if (!download.ok) throw new Error(`Le téléchargement a échoué (${download.status}).`);
  const contentLength = Number(download.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 512 * 1024 * 1024) {
    throw new Error("Le fichier dépasse la limite de téléchargement de 512 Mo.");
  }
  const filename = path.basename(file.filename);
  if (!filename || filename === "." || filename === "..") throw new Error("Nom de fichier Modrinth invalide.");
  const instance = `${version}-${loader}`;
  const destination = path.join(dataPath("instances"), instance, folder);
  await fs.mkdir(destination, { recursive: true });
  const data = await readResponseLimited(download, 512 * 1024 * 1024);
  await fs.writeFile(path.join(destination, filename), data);
  return { filename, folder };
});

ipcMain.handle("modrinth:install-pvp-pack", async (_event, version, loader) => {
  if (!await isPublishedRelease(version)) throw new Error("Choisis une version officielle stable de Minecraft.");
  if (loader !== "fabric") throw new Error("Choisis Fabric pour installer le pack PvP.");
  const files = new Map();
  const skipped = [];
  for (const projectId of pvpAddonProjects) {
    const unavailable = await resolveOptionalModrinthFiles(projectId, version, loader, files);
    if (unavailable) skipped.push(unavailable);
  }
  const destination = dataPath(path.join("instances", `${version}-${loader}`, "mods"));
  const installed = await installModrinthFiles(files, destination);
  return { installed, skipped };
});

ipcMain.handle("skin:save", async (_event, dataUrl) => {
  if (typeof dataUrl !== "string" || !/^data:image\/png;base64,/.test(dataUrl)) {
    throw new Error("Choisis un fichier PNG valide pour le skin.");
  }
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Le skin ne doit pas dépasser 2 Mo.");
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Le fichier sélectionné n’est pas un PNG valide.");
  }
  const state = await readState();
  const skinPath = dataPath("skin.png");
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(skinPath, bytes);
  state.skin = skinPath;
  await writeState(state);
  return { saved: true };
});

ipcMain.handle("skin:upload", async (_event, variant) => {
  if (!["classic", "slim"].includes(variant)) throw new Error("Modèle de skin invalide.");
  const state = await readState();
  const session = await freshAccountSession(state);
  if (!session) throw new Error("Connecte ton compte Microsoft pour publier un skin.");
  if (!state.skin) throw new Error("Choisis d’abord un skin PNG.");
  const bytes = await fs.readFile(state.skin);
  await kit.auth.profile.uploadSkin({
    accessToken: session.mcToken,
    skin: bytes,
    variant: variant === "slim" ? SkinVariantInputs.SLIM : SkinVariantInputs.CLASSIC,
  });
  return true;
});

app.whenReady().then(async () => {
  app.setName("Femboy-Craft");
  Menu.setApplicationMenu(null);
  const cache = await createPersistentMetadataCache({
    directory: dataPath("metadata-cache"),
    onWriteError: (error) => console.error("Impossible de conserver le cache Minecraft :", error),
  });
  kit = new MinecraftKit({ cache });
  await createWindow();
}).catch((error) => {
  console.error("Impossible de démarrer FemboyCraft :", error);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
