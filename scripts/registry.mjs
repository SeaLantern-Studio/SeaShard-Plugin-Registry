import Ajv from "ajv";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import semver from "semver";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registrationsRoot = join(repositoryRoot, "registry", "plugins");
const registrationSchemaPath = join(
  repositoryRoot,
  "schemas",
  "plugin-registration-v1.schema.json",
);
const catalogSchemaPath = join(repositoryRoot, "schemas", "plugin-catalog-v1.schema.json");
const catalogOutputPath = join(repositoryRoot, "dist", "catalog-v1.json");

const maximumArchiveSize = 32 * 1024 * 1024;
const maximumUnpackedSize = 128 * 1024 * 1024;
const maximumFileCount = 4_096;
const maximumFileSize = 32 * 1024 * 1024;
const maximumManifestSize = 256 * 1024;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const contractPattern = /^[a-z0-9](?:[a-z0-9.:-]{0,126}[a-z0-9])?$/u;
const methodPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const hostProfiles = ["electron", "node", "docker"];
const clientTargets = ["desktop", "web", "mobile"];
const operatingSystems = ["win32", "darwin", "linux", "aix", "freebsd", "openbsd", "sunos"];
const architectures = ["x64", "arm64", "ia32", "arm", "riscv64", "ppc64", "s390x"];
const githubAssetHosts = new Set(["github.com", "release-assets.githubusercontent.com"]);

const mode = process.argv.includes("--write") ? "write" : "check";
const baseIndex = process.argv.indexOf("--base");
const baseRef = baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined;
if (process.argv.includes("--write") && process.argv.includes("--check")) {
  throw new Error("choose exactly one registry mode: --check or --write");
}
if (baseIndex >= 0 && !baseRef) throw new Error("--base requires a Git revision");

const registrationSchema = JSON.parse(await readFile(registrationSchemaPath, "utf8"));
const catalogSchema = JSON.parse(await readFile(catalogSchemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validateRegistrationShape = ajv.compile(registrationSchema);
const validateCatalogShape = ajv.compile(catalogSchema);

const registrations = await readRegistrations();
if (baseRef) await validateHistoricalReleases(baseRef, registrations);

const plugins = [];
for (const registration of registrations) {
  plugins.push(await buildCatalogPlugin(registration));
}
plugins.sort((left, right) => left.id.localeCompare(right.id));

const catalog = { schemaVersion: 1, plugins };
if (!validateCatalogShape(catalog)) {
  throw new Error(`generated catalog is invalid:\n${formatAjvErrors(validateCatalogShape.errors)}`);
}
const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
const catalogDigest = sha256(Buffer.from(catalogText));

if (mode === "write") {
  await mkdir(dirname(catalogOutputPath), { recursive: true });
  await writeFile(catalogOutputPath, catalogText, { encoding: "utf8" });
  console.log(`Wrote ${catalogOutputPath}`);
}
console.log(`Valid registry: ${plugins.length} plugin(s), catalog SHA-256 ${catalogDigest}`);

/** 注册文件是人工维护的唯一输入；文件名同时承担插件 ID 唯一索引。 */
async function readRegistrations() {
  const entries = await readdir(registrationsRoot, { withFileTypes: true });
  const unsupported = entries.filter((entry) => !entry.isFile() || !entry.name.endsWith(".json"));
  if (unsupported.length) {
    throw new Error(
      `registry/plugins only accepts JSON files: ${unsupported.map((entry) => entry.name).join(", ")}`,
    );
  }

  const registrations = [];
  const ids = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `registry/plugins/${entry.name}`;
    const document = JSON.parse(await readFile(join(registrationsRoot, entry.name), "utf8"));
    if (!validateRegistrationShape(document)) {
      throw new Error(`${relativePath} is invalid:\n${formatAjvErrors(validateRegistrationShape.errors)}`);
    }
    if (entry.name !== `${document.id}.json`) {
      throw new Error(`${relativePath} must be named ${document.id}.json`);
    }
    if (ids.has(document.id)) throw new Error(`duplicate plugin id: ${document.id}`);
    ids.add(document.id);

    const versions = new Set();
    for (const release of document.releases) {
      if (!semver.valid(release.version)) {
        throw new Error(`${relativePath} has an invalid semantic version: ${release.version}`);
      }
      if (versions.has(release.version)) {
        throw new Error(`${relativePath} repeats version ${release.version}`);
      }
      versions.add(release.version);
    }
    registrations.push({ relativePath, document });
  }
  return registrations;
}

/** 已发布版本以版本号和归档摘要为不可变身份；安全撤回只允许单向设置 yanked。 */
async function validateHistoricalReleases(base, registrations) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", base, "--", "registry/plugins"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const currentByPath = new Map(registrations.map((item) => [item.relativePath, item.document]));
  for (const relativePath of stdout.split(/\r?\n/u).filter(Boolean)) {
    const current = currentByPath.get(relativePath);
    if (!current) {
      throw new Error(`${relativePath} cannot be removed; yank affected releases instead`);
    }
    const { stdout: previousText } = await execFileAsync(
      "git",
      ["show", `${base}:${relativePath}`],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const previous = JSON.parse(previousText);
    const currentReleases = new Map(current.releases.map((release) => [release.version, release]));
    for (const oldRelease of previous.releases) {
      const nextRelease = currentReleases.get(oldRelease.version);
      if (!nextRelease) {
        throw new Error(`${relativePath} cannot remove published version ${oldRelease.version}`);
      }
      for (const field of ["version", "tag", "asset", "archiveSha256"]) {
        if (oldRelease[field] !== nextRelease[field]) {
          throw new Error(`${relativePath} cannot change ${field} for ${oldRelease.version}`);
        }
      }
      if (oldRelease.yanked === true && nextRelease.yanked !== true) {
        throw new Error(`${relativePath} cannot restore yanked version ${oldRelease.version}`);
      }
    }
  }
}

async function buildCatalogPlugin({ relativePath, document }) {
  const repositoryUrl = `https://github.com/${document.source.repository}`;
  const releases = [];
  for (const release of document.releases) {
    const encodedTag = encodeURIComponent(release.tag);
    const encodedAsset = encodeURIComponent(release.asset);
    const releaseUrl = `${repositoryUrl}/releases/tag/${encodedTag}`;
    const downloadUrl = `${repositoryUrl}/releases/download/${encodedTag}/${encodedAsset}`;
    console.log(`Checking ${document.id}@${release.version}`);
    const archive = await downloadArchive(downloadUrl);
    const archiveDigest = sha256(archive);
    if (archiveDigest !== release.archiveSha256) {
      throw new Error(
        `${relativePath} archive SHA-256 mismatch for ${release.version}: expected ${release.archiveSha256}, received ${archiveDigest}`,
      );
    }

    const inspected = inspectPluginArchive(archive);
    if (inspected.manifest.id !== document.id) {
      throw new Error(
        `${relativePath} registers ${document.id}, but ${release.version} contains ${inspected.manifest.id}`,
      );
    }
    if (inspected.manifest.version !== release.version) {
      throw new Error(
        `${relativePath} registers version ${release.version}, but the package contains ${inspected.manifest.version}`,
      );
    }

    releases.push({
      version: release.version,
      tag: release.tag,
      releaseUrl,
      downloadUrl,
      archiveSha256: release.archiveSha256,
      packageDigest: inspected.packageDigest,
      publisher: inspected.manifest.publisher,
      compatibility: inspected.manifest.compatibility,
      entries: inspected.manifest.entries.map(({ module: _module, ...entry }) => entry),
      fileCount: inspected.fileCount,
      unpackedSize: inspected.unpackedSize,
      yanked: release.yanked ?? false,
    });
  }
  releases.sort((left, right) => semver.rcompare(left.version, right.version));

  return {
    id: document.id,
    name: document.name,
    summary: document.summary,
    owners: [...document.owners],
    source: {
      type: "github",
      repository: document.source.repository,
      url: repositoryUrl,
    },
    license: document.license,
    releases,
  };
}

async function downloadArchive(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "SeaShard-Plugin-Registry/1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`plugin release download failed (${response.status}): ${url}`);

  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    (!githubAssetHosts.has(finalUrl.hostname) && !finalUrl.hostname.endsWith(".githubusercontent.com"))
  ) {
    throw new Error(`plugin release redirected to an unsupported host: ${finalUrl.hostname}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumArchiveSize) {
    throw new Error(`plugin archive exceeds ${maximumArchiveSize} bytes: ${url}`);
  }

  const archive = new Uint8Array(await response.arrayBuffer());
  if (archive.byteLength > maximumArchiveSize) {
    throw new Error(`plugin archive exceeds ${maximumArchiveSize} bytes: ${url}`);
  }
  return archive;
}

/** 与 SeaShard Installer 使用同一文件排序与摘要规则，Catalog 因而能固定安装身份。 */
function inspectPluginArchive(archive) {
  let entries;
  try {
    entries = unzipSync(archive);
  } catch (error) {
    throw new Error("plugin archive is not a readable ZIP package", { cause: error });
  }

  const rawNames = Object.keys(entries);
  if (rawNames.length > maximumFileCount) {
    throw new Error(`plugin archive exceeds ${maximumFileCount} entries`);
  }

  const files = [];
  let unpackedSize = 0;
  for (const rawName of rawNames) {
    const directory = rawName.endsWith("/");
    const normalized = normalizeArchivePath(directory ? rawName.slice(0, -1) : rawName);
    if (directory) continue;
    const data = entries[rawName];
    if (data.byteLength > maximumFileSize) {
      throw new Error(`plugin file exceeds ${maximumFileSize} bytes: ${normalized}`);
    }
    unpackedSize += data.byteLength;
    if (unpackedSize > maximumUnpackedSize) {
      throw new Error(`plugin archive exceeds ${maximumUnpackedSize} unpacked bytes`);
    }
    files.push({ relativePath: normalized, data });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  assertUnique(files.map((file) => file.relativePath), "plugin archive paths");

  const manifestFile = files.find((file) => file.relativePath === "plugin.json");
  if (!manifestFile) throw new Error("plugin package does not contain plugin.json");
  if (manifestFile.data.byteLength > maximumManifestSize) {
    throw new Error(`plugin.json exceeds ${maximumManifestSize} bytes`);
  }

  let manifestInput;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.data);
    manifestInput = JSON.parse(text);
  } catch (error) {
    throw new Error("plugin.json is not valid UTF-8 JSON", { cause: error });
  }
  const manifest = parsePluginManifest(manifestInput);
  const paths = new Set(files.map((file) => file.relativePath));
  for (const entry of manifest.entries) {
    if (!paths.has(entry.module.slice(2))) {
      throw new Error(`plugin entry module is missing: ${entry.id} -> ${entry.module}`);
    }
  }

  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.relativePath, "utf8");
    digest.update("\0");
    digest.update(String(file.data.byteLength), "utf8");
    digest.update("\0");
    digest.update(file.data);
    digest.update("\0");
  }
  return {
    manifest,
    packageDigest: digest.digest("hex"),
    fileCount: files.length,
    unpackedSize,
  };
}

function parsePluginManifest(input) {
  const root = recordAt(input, "manifest");
  assertKeys(root, ["id", "version", "publisher", "atomic", "entries", "compatibility"], "manifest");
  const id = patternedString(root.id, "manifest.id", pluginIdPattern);
  const version = stringAt(root.version, "manifest.version");
  if (!semver.valid(version)) throw new Error("manifest.version must be a valid semantic version");
  const publisher = patternedString(root.publisher, "manifest.publisher", pluginIdPattern);
  if (root.atomic !== undefined && typeof root.atomic !== "boolean") {
    throw new Error("manifest.atomic must be a boolean");
  }

  const compatibilityInput = recordAt(root.compatibility, "manifest.compatibility");
  assertKeys(compatibilityInput, ["seaShard", "clientProtocol"], "manifest.compatibility");
  const seaShard = stringAt(compatibilityInput.seaShard, "manifest.compatibility.seaShard");
  if (!semver.validRange(seaShard)) {
    throw new Error("manifest.compatibility.seaShard must be a valid semantic-version range");
  }
  const compatibility = { seaShard };
  if (compatibilityInput.clientProtocol !== undefined) {
    compatibility.clientProtocol = stringAt(
      compatibilityInput.clientProtocol,
      "manifest.compatibility.clientProtocol",
    );
  }

  if (!Array.isArray(root.entries) || root.entries.length === 0) {
    throw new Error("manifest.entries must contain at least one entry");
  }
  const entries = root.entries.map((entry, index) => parseManifestEntry(entry, index));
  assertUnique(entries.map((entry) => entry.id), "manifest entry ids");
  return { id, version, publisher, compatibility, entries };
}

function parseManifestEntry(input, index) {
  const path = `manifest.entries[${index}]`;
  const entry = recordAt(input, path);
  assertKeys(entry, ["id", "runtime", "module", "hostProfiles", "targets", "uses", "os", "arch"], path);
  const id = patternedString(entry.id, `${path}.id`, pluginIdPattern);
  const runtime = enumAt(entry.runtime, `${path}.runtime`, ["host", "client"]);
  const module = stringAt(entry.module, `${path}.module`);
  if (!isSafeModulePath(module)) {
    throw new Error(`${path}.module must be a relative ESM .js or .mjs path without traversal`);
  }
  const uses = parseUses(entry.uses, `${path}.uses`);
  const result = { id, runtime, module, uses };

  if (runtime === "host") {
    result.hostProfiles = enumArrayAt(entry.hostProfiles, `${path}.hostProfiles`, hostProfiles);
    if (entry.targets !== undefined) throw new Error(`${path}.targets is only valid for client entries`);
  } else {
    result.targets = enumArrayAt(entry.targets, `${path}.targets`, clientTargets);
    if (entry.hostProfiles !== undefined) {
      throw new Error(`${path}.hostProfiles is only valid for host entries`);
    }
  }
  if (entry.os !== undefined) result.os = enumArrayAt(entry.os, `${path}.os`, operatingSystems);
  if (entry.arch !== undefined) result.arch = enumArrayAt(entry.arch, `${path}.arch`, architectures);
  return result;
}

function parseUses(input, path) {
  const source = recordAt(input, path);
  const uses = {};
  for (const contract of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
    if (!contractPattern.test(contract)) throw new Error(`${path}.${contract} is not a valid contract id`);
    const methods = source[contract];
    if (!Array.isArray(methods) || methods.length === 0) {
      throw new Error(`${path}.${contract} must contain at least one method`);
    }
    const normalized = methods.map((method, index) =>
      patternedString(method, `${path}.${contract}[${index}]`, methodPattern),
    );
    assertUnique(normalized, `${path}.${contract}`);
    uses[contract] = normalized.sort((left, right) => left.localeCompare(right));
  }
  return uses;
}

function normalizeArchivePath(value) {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  return segments.join("/");
}

function isSafeModulePath(value) {
  if (!value.startsWith("./") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return false;
  return value.endsWith(".js") || value.endsWith(".mjs");
}

function recordAt(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function assertKeys(value, allowed, path) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length) throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
}

function stringAt(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function patternedString(value, path, pattern) {
  const normalized = stringAt(value, path);
  if (!pattern.test(normalized)) throw new Error(`${path} has an invalid value`);
  return normalized;
}

function enumAt(value, path, values) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${path} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function enumArrayAt(value, path, values) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must contain at least one value`);
  }
  const result = value.map((item, index) => enumAt(item, `${path}[${index}]`, values));
  assertUnique(result, path);
  return result;
}

function assertUnique(values, path) {
  if (new Set(values).size !== values.length) throw new Error(`${path} must contain unique values`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => `- ${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("\n");
}
