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
}): Promise<Record<string, number | boolean>> {
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
      if (input.scenario === "folder-delete-child-revision-race")
        await store.write("F/n.md", "original", undefined, 1000);
      else await store.create("F", true);
      await run();
      await store.delete("F");
      const snapshot = remote.snapshot.bind(remote);
      let recursiveDeleteRequests = 0;
      if (input.scenario === "folder-delete-unsupported") {
        const auth = new Auth(store, { dropbox: "public", onedrive: "public" });
        auth.authorized = async () => {
          recursiveDeleteRequests++;
          throw new Error("Unexpected recursive delete request");
        };
        const cloud = new Dropbox(auth, account);
        remote.delete = (entry) => cloud.delete(entry);
      } else {
        remote.snapshot = async () => {
          const entries = await snapshot();
          if (input.scenario === "folder-delete-concurrent-upload")
            await remote.edit("F/new.md", "unseen", 2000);
          else if (input.scenario === "folder-delete-child-revision-race")
            await remote.edit("F/n.md", "changed", 2000);
          else throw new Error(`Unknown safety scenario: ${input.scenario}`);
          return entries;
        };
      }
      const result = await run();
      const history = await records();
      const common = {
        errors: result.errors.length,
        folderRecordRetained: history.some((r) => r.path === "F"),
      };
      if (input.scenario === "folder-delete-unsupported")
        return { ...common, recursiveDeleteRequests };
      if (input.scenario === "folder-delete-child-revision-race")
        return {
          ...common,
          changedChildPreserved: remote.data.get("F/n.md")?.text === "changed",
          childRecordRetained: history.some((r) => r.path === "F/n.md"),
        };
      return {
        ...common,
        unseenPreserved: remote.data.get("F/new.md")?.text === "unseen",
      };
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
        store.put = async (key, value) => {
          await put(key, value);
          if (
            !crashed &&
            key === "fixture:records" &&
            (input.crashAfter === "winner-record" ||
              (value as RecordState[]).some((r) =>
                r.path.includes("conflicted copy"),
              ))
          )
            crash();
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
