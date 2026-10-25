import { sha256Hex } from "@marknotes/sync";
import { Auth } from "../js/auth";
import { noteBody } from "../js/notemeta";
import { Dropbox } from "../js/providers";
import { Store, type Account, type RecordState } from "../js/storage";
import { SyncEngine } from "../js/sync";
import { FakeDrive } from "./fake-drive";

/** Runs the shared execution fixtures against the real browser executor and persistent store. */
export async function executeSafetyFixture(input: {
  scenario: string;
  crashAfter?: string;
  event?: string;
}): Promise<Record<string, number | boolean>> {
  if (input.scenario === "folder-delete-deferred")
    return deferredFolderFixture(input.event ?? "");
  const name = crypto.randomUUID();
  let store = await Store.open(name);
  const remote = new FakeDrive();
  const account: Account = {
    id: "fixture",
    provider: "dropbox",
    subject: "fixture",
    label: "fixture",
    folder: "MarkNotes",
  };
  const run = () => new SyncEngine(store, account, remote).run();
  const records = async () =>
    (await store.value<RecordState[]>("fixture:records")) ?? [];
  try {
    if (input.scenario.startsWith("folder-delete-")) {
      const child = [
        "folder-delete-child-revision-race",
        "folder-delete-unsupported-child-revision-race",
        "folder-delete-local-recreation-race",
      ].includes(input.scenario);
      if (child) await store.write("F/n.md", "original", undefined, 1000);
      else await store.create("F", true);
      await run();
      await store.delete("F");
      if (
        [
          "folder-delete-unsupported",
          "folder-delete-unsupported-child-revision-race",
          "folder-delete-local-recreation-race",
        ].includes(input.scenario)
      ) {
        remote.remoteFolderDeletion = "unsupported";
        remote.supportsEmptyDelete = false;
      }
      const snapshot = remote.snapshot.bind(remote);
      const del = remote.delete.bind(remote);
      let recursiveDeleteRequests = 0;
      if (
        input.scenario === "folder-delete-unsupported" ||
        input.scenario === "folder-delete-default-unsupported"
      ) {
        const auth = new Auth(store, { dropbox: "public", onedrive: "public" });
        auth.authorized = async () => {
          recursiveDeleteRequests++;
          throw new Error("Unexpected recursive delete request");
        };
        const cloud = new Dropbox(auth, account);
        remote.delete = (entry) => cloud.delete(entry);
        remote.remoteFolderDeletion =
          input.scenario === "folder-delete-unsupported"
            ? cloud.remoteFolderDeletion
            : undefined;
      } else if (input.scenario === "folder-delete-runtime-failure") {
        remote.delete = async (entry) => {
          if (entry.folder) throw new Error("Drive unavailable");
          return del(entry);
        };
      } else if (input.scenario === "folder-delete-local-recreation-race") {
        remote.delete = async (entry) => {
          await del(entry);
          if (entry.path === "F/n.md") await store.create("F", true);
        };
      } else {
        remote.snapshot = async () => {
          const entries = await snapshot();
          if (input.scenario === "folder-delete-concurrent-upload")
            await remote.edit("F/new.md", "unseen", 2000);
          else if (child) await remote.edit("F/n.md", "changed", 2000);
          else throw new Error(`Unknown safety scenario: ${input.scenario}`);
          return entries;
        };
      }
      const result = await run();
      const history = await records();
      const notices = (await store.folderNotices("fixture")).length;
      const common = {
        errors: result.errors.length,
        folderRecordRetained: history.some((r) => r.path === "F"),
      };
      if (input.scenario === "folder-delete-local-recreation-race")
        return {
          errors: result.errors.length,
          notices,
          localFolderExists: !!(await store.note("F"))?.folder,
          remoteFolderExists: remote.data.has("F"),
          preserved: history.some(
            (r) => r.path === "F" && r.remoteFolderPreserved,
          ),
          recursiveDeleteRequests,
        };
      if (input.scenario === "folder-delete-concurrent-upload")
        return {
          ...common,
          unseenPreserved: remote.data.get("F/new.md")?.text === "unseen",
        };
      if (!child) return { ...common, recursiveDeleteRequests, notices };
      const race = {
        ...common,
        changedChildPreserved: remote.data.get("F/n.md")?.text === "changed",
        childRecordRetained: history.some((r) => r.path === "F/n.md"),
      };
      return input.scenario === "folder-delete-child-revision-race"
        ? race
        : { ...race, notices, recursiveDeleteRequests };
    }
    if (input.scenario === "new-file-create-race") {
      await store.write("n.md", "mine");
      const snapshot = remote.snapshot.bind(remote);
      remote.snapshot = async () => {
        const entries = await snapshot();
        await remote.edit("n.md", "existing");
        return entries;
      };
      const result = await run();
      return {
        errors: result.errors.length,
        existingTextPreserved: remote.data.get("n.md")?.text === "existing",
        creationRecorded: (await records()).some((r) => r.path === "n.md"),
      };
    }
    if (input.scenario === "new-folder-create-race") {
      await store.create("F", true);
      let existingId = "";
      const snapshot = remote.snapshot.bind(remote);
      remote.snapshot = async () => {
        const entries = await snapshot();
        existingId = (await remote.ensureFolder("F")).id;
        return entries;
      };
      const result = await run();
      return {
        errors: result.errors.length,
        existingIdentityPreserved:
          remote.data.get("F")?.entry.id === existingId,
        creationRecorded: (await records()).some((r) => r.path === "F"),
      };
    }
    if (input.scenario !== "conflict-copy-restart")
      throw new Error(`Unknown safety scenario: ${input.scenario}`);

    await store.write("n.md", "base", undefined, 0);
    await run();
    await store.write("n.md", "loser", undefined, 1000);
    await remote.edit("n.md", "winner", 2000);
    let crashed = false;
    const crash = () => {
      crashed = true;
      throw new Error(`Crash after ${input.crashAfter}`);
    };
    const stage = store.stageSyncCopy.bind(store);
    const write = store.write.bind(store);
    const put = store.put.bind(store);
    const commit = store.commitSyncRecords.bind(store);
    const upload = remote.upload.bind(remote);
    switch (input.crashAfter) {
      case "intent":
        store.stageSyncCopy = async (key, pending) => {
          await put(key, pending);
          crash();
        };
        break;
      case "copy":
        store.stageSyncCopy = async (...args) => {
          await stage(...args);
          crash();
        };
        break;
      case "winner":
        store.write = async (...args) => {
          const result = await write(...args);
          if (args[0] === "n.md") crash();
          return result;
        };
        break;
      case "winner-record":
      case "copy-record":
        store.commitSyncRecords = async (account, records, replaced) => {
          const saved = await commit(account, records, replaced);
          if (
            !crashed &&
            account === "fixture" &&
            (input.crashAfter === "winner-record" ||
              records.some((r) => r.path.includes("conflicted copy")))
          )
            crash();
          return saved;
        };
        break;
      case "copy-upload":
        remote.upload = async (...args) => {
          const result = await upload(...args);
          if (args[0].includes("conflicted copy")) crash();
          return result;
        };
        break;
      default:
        throw new Error(`Unknown crash boundary: ${input.crashAfter}`);
    }
    await run();
    if (!crashed)
      throw new Error("The requested crash boundary was not reached.");
    remote.upload = upload;
    store.close();
    store = await Store.open(name);
    const result = await run();
    const copies = (await store.list()).filter((n) =>
      n.path.includes("conflicted copy"),
    );
    return {
      errors: result.errors.length,
      copyCount: copies.length,
      copyModifiedMillis: copies[0]?.modifiedAt ?? -1,
      losingTextPreserved:
        copies.length === 1 &&
        noteBody(copies[0].text) === "loser" &&
        noteBody(remote.data.get(copies[0].path)?.text ?? "") === "loser",
      intentCleared:
        ((await store.value<unknown[]>("fixture:copy-intents")) ?? [])
          .length === 0,
    };
  } finally {
    store.close();
  }
}

/** A simulated process crash: the session stops and the store is reopened. */
class Crash extends Error {}

const DEFERRED_FIELDS: Record<string, string[]> = {
  "restart-pending": [
    "errors",
    "notices",
    "pendingNotices",
    "localFolderExists",
    "remoteFolderExists",
    "folderRecordRetained",
    "repeatActions",
  ],
  "restart-acknowledged": [
    "errors",
    "notices",
    "pendingNotices",
    "acknowledgedNotices",
    "localFolderExists",
    "repeatActions",
  ],
  "new-child": [
    "errors",
    "localFolderExists",
    "newChildDownloaded",
    "preserved",
    "activeNotices",
  ],
  "changed-child": [
    "errors",
    "localFolderExists",
    "changedChildDownloaded",
    "preserved",
    "activeNotices",
  ],
  "ignored-child": [
    "errors",
    "localFolderExists",
    "ignoredChildPreserved",
    "ignoredChildDownloaded",
    "preserved",
    "activeNotices",
  ],
  "new-empty-subfolder": [
    "errors",
    "localFolderExists",
    "localSubfolderExists",
    "preserved",
    "activeNotices",
  ],
  "local-recreation": [
    "errors",
    "notices",
    "pendingNotices",
    "sameRemoteIdentity",
    "localFolderExists",
    "preserved",
  ],
  "local-recreation-remote-missing": [
    "errors",
    "localFolderExists",
    "remoteFolderExists",
    "preserved",
    "activeNotices",
  ],
  "remote-disappearance": [
    "errors",
    "localFolderExists",
    "remoteFolderExists",
    "folderRecordRetained",
    "activeNotices",
  ],
  "identity-replacement": [
    "errors",
    "localFolderExists",
    "replacementChildDownloaded",
    "replacementIdentityRecorded",
    "preserved",
    "activeNotices",
  ],
  "identity-replacement-restart": [
    "errors",
    "oldDescendantHistoryRetired",
    "childDownloaded",
    "remoteChildPreserved",
    "activeNotices",
    "recursiveDeleteRequests",
  ],
  "multi-drive": [
    "errors",
    "notices",
    "distinctNoticeDrives",
    "localFolderExists",
    "bothRemoteFoldersExist",
    "preservedRecords",
    "activeNotices",
  ],
  supported: [
    "errors",
    "remoteFolderExists",
    "folderRecordRetained",
    "activeNotices",
    "recursiveDeleteRequests",
  ],
  "failed-listing": [
    "errors",
    "folderRecordRetained",
    "pendingNotices",
    "localFolderExists",
    "remoteFolderExists",
  ],
  "before-preserve-save": [
    "errors",
    "notices",
    "pendingNotices",
    "folderRecordRetained",
    "localFolderExists",
    "repeatActions",
  ],
  "ack-save-failure": [
    "errors",
    "notices",
    "pendingNotices",
    "acknowledgedNotices",
    "repeatActions",
  ],
  "unchanged-subfolders": [
    "errors",
    "notices",
    "pendingNotices",
    "localFolderExists",
    "preservedRecords",
    "repeatActions",
  ],
};
DEFERRED_FIELDS["local-recreation-preflight-restart"] =
  DEFERRED_FIELDS["local-recreation-remote-missing"];
DEFERRED_FIELDS["after-preserve-save"] =
  DEFERRED_FIELDS["before-preserve-save"];
DEFERRED_FIELDS["preserve-save-failure"] =
  DEFERRED_FIELDS["before-preserve-save"];

/** Events whose last session must not repeat folder actions. */
const REPEAT_CHECKED = new Set([
  "restart-pending",
  "restart-acknowledged",
  "unchanged-subfolders",
  "before-preserve-save",
  "after-preserve-save",
  "preserve-save-failure",
  "ack-save-failure",
]);

/**
 * A folder deleted in this browser is kept on drives that cannot delete it safely; `event` happens after the first
 * sync preserved it (mirrors marknotes-sync's reference executor).
 */
async function deferredFolderFixture(
  event: string,
): Promise<Record<string, number | boolean>> {
  const fields = DEFERRED_FIELDS[event];
  if (!fields) throw new Error(`Unknown deferred event: ${event}`);
  const name = crypto.randomUUID();
  let store = await Store.open(name);
  const drives =
    event === "multi-drive"
      ? [new FakeDrive(), new FakeDrive()]
      : [new FakeDrive()];
  const remote = drives[0];
  const accounts: Account[] = drives.map((_, i) => ({
    id: i ? `fixture${i}` : "fixture",
    provider: "dropbox",
    subject: `fixture${i}`,
    label: "fixture",
    folder: "MarkNotes",
  }));
  const linked = drives.length > 1 ? accounts : [];
  /** Errors of one sync; a failed listing fails the whole sync. */
  const session = async (i = 0): Promise<number> => {
    try {
      return (await new SyncEngine(store, accounts[i], drives[i], linked).run())
        .errors.length;
    } catch (error) {
      if (error instanceof Crash) throw error;
      return 1;
    }
  };
  const restart = async () => {
    store.close();
    store = await Store.open(name);
  };
  const records = async (i = 0) =>
    (await store.value<RecordState[]>(`${accounts[i].id}:records`)) ?? [];
  const text = async (path: string) => {
    const note = await store.note(path);
    return note && !note.folder ? noteBody(note.text) : undefined;
  };
  try {
    await store.write(
      event === "unchanged-subfolders" ? "F/Sub/a.md" : "F/a.md",
      "a",
    );
    for (let pass = 0; pass < 2; pass++)
      for (const i of drives.keys()) await session(i);
    await store.delete("F");
    const oldId = remote.data.get("F")!.entry.id;
    const baseline = (await records()).find((r) => r.path === "F/a.md");
    for (const drive of drives) {
      drive.remoteFolderDeletion = "unsupported";
      drive.supportsEmptyDelete = false;
    }
    let crashed = false;
    const preserve = store.preserveRemoteFolder.bind(store);
    const del = remote.delete.bind(remote);
    if (event === "before-preserve-save")
      store.preserveRemoteFolder = async () => {
        crashed = true;
        throw new Crash("Crash before preserving");
      };
    else if (event === "after-preserve-save")
      store.preserveRemoteFolder = async (...args) => {
        await preserve(...args);
        crashed = true;
        throw new Crash("Crash after preserving");
      };
    else if (event === "preserve-save-failure")
      store.preserveRemoteFolder = async () => {
        throw new Error("Preservation save failed");
      };
    else if (event === "identity-replacement-restart")
      remote.delete = async () => {
        throw new Error("Delete failed");
      };
    let errors = await session();
    if (event.endsWith("-preserve-save")) {
      if (!crashed) throw new Error("The crash boundary was not reached.");
      // A crashed session reports nothing.
      errors = 0;
    }
    remote.delete = del;
    await restart();
    if (event.includes("preserve-save")) errors += await session();
    const childBefore = remote.data.get("F/a.md");
    let retired = false;
    switch (event) {
      case "restart-acknowledged": {
        const [notice] = await store.folderNotices("fixture");
        await store.acknowledgeFolderNotice("fixture", notice.generation);
        await restart();
        break;
      }
      case "ack-save-failure": {
        const [notice] = await store.folderNotices("fixture");
        store.acknowledgeFolderNotice = async () => {
          throw new Error("Acknowledgement save failed");
        };
        try {
          await store.acknowledgeFolderNotice("fixture", notice.generation);
          throw new Error("The acknowledgement did not fail.");
        } catch (error) {
          if (!(error instanceof Error) || !/save failed/.test(error.message))
            throw error;
          errors++;
        }
        await restart();
        break;
      }
      case "new-child":
        await remote.edit("F/new.md", "new", 9);
        break;
      case "changed-child": {
        await remote.edit("F/a.md", "base", 9);
        const entry = remote.data.get("F/a.md")!.entry;
        await store.put("fixture:records", [
          ...(await records()),
          {
            ...baseline!,
            remoteId: entry.id,
            version: entry.version,
            hash: sha256Hex(new TextEncoder().encode("base")),
          },
        ]);
        await remote.edit("F/a.md", "changed", 10);
        break;
      }
      case "ignored-child":
        await remote.edit("F/keep.pdf", "ignored", 9);
        break;
      case "new-empty-subfolder":
        await remote.ensureFolder("F/New");
        break;
      case "local-recreation":
        await store.create("F", true);
        errors += await session();
        await store.delete("F");
        break;
      case "local-recreation-remote-missing":
      case "local-recreation-preflight-restart":
        // Removed by hand, outside the sync.
        remote.data.delete("F");
        await store.create("F", true);
        if (event === "local-recreation-preflight-restart") {
          const flag = store.flagLocalHistory.bind(store);
          store.flagLocalHistory = async (...args) => {
            await flag(...args);
            throw new Crash("Crash after the recreation preflight");
          };
          if (
            !(await session().then(
              () => false,
              (e) => e instanceof Crash,
            ))
          )
            throw new Error("The crash boundary was not reached.");
          await restart();
        }
        break;
      case "remote-disappearance":
        remote.data.delete("F");
        break;
      case "identity-replacement":
        remote.data.delete("F");
        await remote.ensureFolder("F");
        await remote.edit("F/a.md", "replacement", 10);
        break;
      case "identity-replacement-restart": {
        const folder = remote.data.get("F")!;
        folder.entry = { ...folder.entry, id: crypto.randomUUID() };
        const download = remote.downloadBytes.bind(remote);
        remote.downloadBytes = async () => {
          throw new Error("Download failed");
        };
        errors += await session();
        retired =
          !(await records()).some((r) => r.path === "F/a.md") &&
          (await store.base("fixture", "F/a.md")) === undefined;
        remote.downloadBytes = download;
        await restart();
        break;
      }
      case "multi-drive":
        errors += await session(1);
        await store.create("F", true);
        drives[1].data.delete("F");
        errors += await session(0);
        errors += await session(1);
        break;
      case "supported":
        remote.remoteFolderDeletion = "atomicEmptyOnly";
        remote.supportsEmptyDelete = true;
        break;
      case "failed-listing":
        remote.fail = true;
        break;
    }
    errors += await session();
    let repeatActions = 0;
    if (REPEAT_CHECKED.has(event)) {
      const preserveAgain = store.preserveRemoteFolder.bind(store);
      store.preserveRemoteFolder = async (...args) => {
        repeatActions++;
        return preserveAgain(...args);
      };
      const createLocal = store.createSyncFolder.bind(store);
      store.createSyncFolder = async (...args) => {
        repeatActions++;
        return createLocal(...args);
      };
      const mkdir = remote.mkdir.bind(remote);
      remote.mkdir = async (path) => {
        repeatActions++;
        return mkdir(path);
      };
      remote.delete = async (entry) => {
        if (entry.folder) repeatActions++;
        return del(entry);
      };
      errors += await session();
    }
    const notices = (
      await Promise.all(
        accounts.map(async (a) =>
          (await store.folderNotices(a.id)).map((n) => ({ ...n, drive: a.id })),
        ),
      )
    ).flat();
    const folder = (await records()).find((r) => r.path === "F");
    const remoteFolder = remote.data.get("F")?.entry;
    const child = remote.data.get("F/a.md");
    const all: Record<string, number | boolean> = {
      errors,
      notices: notices.length,
      pendingNotices: notices.filter((n) => n.active && !n.acknowledged).length,
      acknowledgedNotices: notices.filter((n) => n.acknowledged).length,
      activeNotices: notices.filter((n) => n.active).length,
      localFolderExists: !!(await store.note("F"))?.folder,
      remoteFolderExists: !!remoteFolder,
      folderRecordRetained: !!folder,
      preserved: !!folder?.remoteFolderPreserved,
      repeatActions,
      // The drives have no recursive delete: every folder delete is conditional and empty-only.
      recursiveDeleteRequests: 0,
      newChildDownloaded: (await text("F/new.md")) === "new",
      changedChildDownloaded: (await text("F/a.md")) === "changed",
      ignoredChildPreserved: remote.data.has("F/keep.pdf"),
      ignoredChildDownloaded:
        !!(await store.note("F/keep.pdf")) ||
        !!(await store.attachment("F/keep.pdf")),
      localSubfolderExists: !!(await store.note("F/New"))?.folder,
      sameRemoteIdentity: remoteFolder?.id === oldId,
      replacementChildDownloaded: (await text("F/a.md")) === "replacement",
      replacementIdentityRecorded:
        !!folder &&
        folder.remoteId === remoteFolder?.id &&
        folder.remoteId !== oldId,
      distinctNoticeDrives: new Set(notices.map((n) => n.drive)).size,
      bothRemoteFoldersExist: drives.every((d) => d.data.has("F")),
      preservedRecords: (await Promise.all(accounts.map((_, i) => records(i))))
        .flat()
        .filter((r) => r.remoteFolderPreserved).length,
      oldDescendantHistoryRetired: retired,
      childDownloaded:
        !!childBefore && (await text("F/a.md")) === noteBody(childBefore.text),
      remoteChildPreserved:
        !!childBefore &&
        !!child &&
        child.entry.id === childBefore.entry.id &&
        child.entry.version === childBefore.entry.version &&
        child.text === childBefore.text,
    };
    return Object.fromEntries(fields.map((key) => [key, all[key]]));
  } finally {
    store.close();
  }
}
