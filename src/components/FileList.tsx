import { FileManager } from "~/lib/filemanager";
import FileItem from "~/components/FileItem";

interface Props {
  files: FileMeta[];
  manager: FileManager;
}

export default function FileList({ manager, files }: Props) {
  //console.log("FILE LIST RERENDERED");
  return (
    <div style={{ paddingBottom: "8em" }}>
      {files.length ? (
        files.map((file) => (
          <FileItem key={file.id} file={file} manager={manager} />
        ))
      ) : (
        <p style={{ textAlign: "center", fontSize: "1.5em", color: "#737373" }}>
          No files imported.
          <br /> Use the "+" button to add files.
        </p>
      )}
    </div>
  );
}
