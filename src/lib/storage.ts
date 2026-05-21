import Dexie, { type Table } from "dexie";

export const db = new Dexie("appdb") as Dexie & {
  files: Table<FileMeta, string>;
  chunks: Table<Chunk, [string, number]>;
};
db.version(1).stores({ files: "id", chunks: "[file+id], pending" });
db.version(2).stores({ files: "id", chunks: "[file+id], file" });
db.version(3)
  .stores({ files: "id", chunks: "[file+id], file" })
  .upgrade((tx) =>
    tx
      .table<FileMeta>("files")
      .toCollection()
      .modify((file) => {
        file.sentBytes = file.sentBytes || 0;
      }),
  );
