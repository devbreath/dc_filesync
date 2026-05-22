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
db.version(4)
  .stores({ files: "id", chunks: "[file+id], file" })
  .upgrade((tx) =>
    tx
      .table<FileMeta>("files")
      .toCollection()
      .modify((file) => {
        file.sentBytes = Math.min(file.sentBytes || 0, Math.max(file.size, 0));
        file.sentChunks = file.sentChunks || [];
      }),
  );
db.version(5)
  .stores({ files: "id", chunks: "[file+id], file" })
  .upgrade((tx) =>
    tx
      .table<FileMeta>("files")
      .toCollection()
      .modify((file) => {
        file.retransmitCount = file.retransmitCount || 0;
        file.retransmitBytes = file.retransmitBytes || 0;
      }),
  );
